import { existsSync } from 'node:fs';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { Task } from '../../../core/schemas/task.js';
import type { Summary } from '../../../core/schemas/summary.js';
import type { Session } from '../../../core/schemas/session.js';
import type { SpecMetadata } from '../../../core/paths-io.js';
import { DEFAULT_WORKFLOW_MODE, type Config } from '../../../core/schemas/config.js';
import { createInitialState } from '../../../core/state/machine.js';
import { pruneOrphanSessions } from '../../../core/sessions/orphans.js';
import { recordRunnerPid, releaseRunnerPid } from '../../../core/sessions/runner-pids.js';
import { runPricingIdentity } from '../../../core/providers/pricing-identity.js';
import {
  clearProcessLedger,
  killAllProcesses,
  setProcessLedger,
} from '../../../lib/process/registry.js';
import { toErrorMessage } from '../../../utils/format-errors.js';
import { error } from '../../../utils/error.js';
import { assertNever } from '../../../utils/type-guards.js';
import { warnError } from '../../../lib/warn.js';

import {
  WORKFLOW_CANCEL_REASON_USER,
  workflowCancelledReasonFromSignal,
} from '../../events/workflow-cancel.js';
import type { ResumeContextHolder, WorkflowContext } from '../types.js';
import { buildSummary, type SummaryBase } from '../summary/build.js';
import { publishError, publishWarning } from '../events.js';
import { saveFinalSession, shouldPreserveActiveState } from '../session-lifecycle/finalize.js';
import { withShutdownHandlers } from '../session-lifecycle/shutdown.js';
import { installQueueHandler } from '../session-lifecycle/install-queue.js';
import { createRunIsolation } from '../isolation/create.js';

import { type RunWorkflowOptions, initializeWorkflow } from './init.js';
import { clearBridgedCliState } from '../../runners/sandbox-state-bridge.js';
import { getIsolationStrategy } from '../../../core/config/accessors/values.js';
import { reapOrphanRunners } from './orphan-reaper.js';
import { runPlanningPhases } from './phases.js';
import { runTasksAndReview } from './task-execution.js';
import {
  withPlannerCallPublishing,
  withReviewerCallPublishing,
  type PlannerCallPublisherContext,
} from './call-publishing.js';
import { acquireLiveness } from './liveness.js';
import { readWorkflowStateHead } from '../state-ops.js';
import { sessionDir } from '../../../core/paths.js';

function resolveSessionStart(savedState: WorkflowState | undefined): number {
  if (!savedState) return Date.now();
  const original = Date.parse(savedState.startedAt);
  return Number.isNaN(original) ? Date.now() : original;
}

/**
 * A new-workflow run applies START, which the state machine accepts only from
 * `idle`. `prepareNewSession` allocates a session directory that cannot already
 * exist (a non-recursive mkdir plus an exclusive ownership marker), and the only
 * other path that carries a resume state — a seat swap — is typed `purpose:
 * 'resume'`, so no caller can reach here over a started session. Refusing before
 * the run touches liveness, isolation, or state keeps that an internal invariant
 * instead of a transition error raised half-way into a session it then marks
 * failed.
 */
function assertNewWorkflowSessionUnstarted(
  ref: Readonly<{ projectDir: string; sessionId: string }>,
): void {
  // A run whose session directory has not been created yet holds no state, and
  // reading the head would resolve a path that does not exist.
  if (!existsSync(sessionDir(ref.projectDir, ref.sessionId))) return;
  const head = readWorkflowStateHead(ref);
  if (head === null || head.state.phase === 'idle') return;
  throw error(
    'workflow-session-already-started',
    `Internal invariant: session ${ref.sessionId} already holds workflow state at phase ${head.state.phase}; a new-workflow run requires a freshly allocated session.`,
    { sessionId: ref.sessionId, phase: head.state.phase },
  );
}

export async function runWorkflow(opts: RunWorkflowOptions): Promise<Summary> {
  const { runtime, session } = opts.prepared;
  const config = opts.prepared.config;
  const feature = runtime.feature;
  const projectDir = session.ref.projectDir;
  const sessionId = session.ref.sessionId;
  if (opts.prepared.purpose === 'new-workflow') {
    assertNewWorkflowSessionUnstarted({ projectDir, sessionId });
  }
  const requestedSavedState = opts.savedState ?? runtime.resumeState;
  let savedState: WorkflowState | undefined;
  const { selectedSkills } = opts;
  // A boundary interrupt raised before this run started (Esc-Esc in a dead zone
  // of a previous run that then ended into recovery without passing a call
  // boundary) is stale: drain it so it cannot park this run's first call
  // boundary on an interrupt nobody requested.
  opts.sinks.consumeBoundaryInterrupt?.();
  const startTime = resolveSessionStart(requestedSavedState);
  // The run's display identity is the seat it is on now, so it comes from the
  // config and never from the saved state. The seat the tokens were spent
  // against is recorded in the state, and `buildSummary` prices the run from
  // there — a run that swapped seats mid-flight names the new one and is still
  // costed against the old one.
  const seatIdentityOf = (source: Config): SummaryBase => {
    const ident = runPricingIdentity(source);
    return {
      feature,
      startTime,
      plannerTool: ident.plannerTool,
      ...(ident.plannerModel !== undefined && { plannerModel: ident.plannerModel }),
      implementerTool: ident.implementerTool,
      ...(ident.implementerModel !== undefined && { implementerModel: ident.implementerModel }),
      ...(ident.reviewerTool !== undefined && { reviewerTool: ident.reviewerTool }),
      ...(ident.reviewerModel !== undefined && { reviewerModel: ident.reviewerModel }),
      mode: source.workflow.mode ?? DEFAULT_WORKFLOW_MODE,
      projectDir,
      sessionId,
      ...(opts.modelCache !== undefined && { pricingCache: opts.modelCache }),
    };
  };
  let summaryBase = seatIdentityOf(config);

  const metadata: SpecMetadata = {
    plannerTool: summaryBase.plannerTool,
    plannerModel: summaryBase.plannerModel,
    implementerTool: summaryBase.implementerTool,
    implementerModel: summaryBase.implementerModel,
    mode: config.workflow.mode ?? DEFAULT_WORKFLOW_MODE,
  };

  // A seat swap re-prepares this same session, which mints a new active-pointer
  // receipt; finalization must clear the pointer with the receipt that is
  // actually on disk, not the one this run started with.
  let activeSession = session.active;
  let trackedState: WorkflowState | undefined;
  let currentTask: Pick<Task, 'file' | 'action'> | undefined;
  let result: Summary | undefined;
  let sessionStatus: Session['status'] = 'interrupted';
  let wctx: WorkflowContext | undefined;
  let workflowBus: WorkflowContext['bus'] | undefined;
  let workflowPhase: WorkflowState['phase'] | undefined;
  let cancellationPublished = false;
  let transientRewindFeedback = opts.rewindFeedback;

  const trackState = (state: WorkflowState): void => {
    trackedState = state;
  };

  const publishWorkflowCancellation = (reason: typeof WORKFLOW_CANCEL_REASON_USER): void => {
    const bus = wctx?.bus ?? workflowBus;
    if (!bus || cancellationPublished) return;
    bus.publish({
      type: 'workflow_cancelled',
      ts: Date.now(),
      phase: trackedState?.phase ?? workflowPhase ?? createInitialState(feature).phase,
      reason,
    });
    cancellationPublished = true;
  };

  await reapOrphanRunners(projectDir);
  try {
    pruneOrphanSessions({ projectDir });
  } catch (err) {
    warnError('orphan sessions: cannot prune session directories', err);
  }

  const releaseLiveness = await acquireLiveness({
    projectDir,
    sessionId,
    feature,
    mode: config.workflow.mode ?? DEFAULT_WORKFLOW_MODE,
    signal: opts.signal,
  });

  const ref = { projectDir, sessionId };
  const runProcessLedger = {
    // A null start time is recorded as null: the orphan reaper refuses to kill
    // entries without start-time identity, which a 0 sentinel would defeat.
    record: (pid: number, startTimeMs: number | null) => recordRunnerPid(ref, pid, startTimeMs),
    release: (pid: number) => releaseRunnerPid(ref, pid),
  };
  setProcessLedger(runProcessLedger);

  // Run-scoped isolation, built before init and disposed in the outer finally. The notice
  // callbacks resolve the bus and phase late, exactly like publishWorkflowCancellation.
  const isolation = createRunIsolation({
    projectDir,
    sessionId,
    strategy: getIsolationStrategy(config),
    onFallback: (reason: string): void => {
      const bus = wctx?.bus ?? workflowBus;
      if (!bus) return;
      publishWarning({
        bus,
        phase: trackedState?.phase ?? workflowPhase ?? createInitialState(feature).phase,
        message: `Isolation worktree unavailable; falling back to a staged copy: ${reason}`,
      });
    },
    onRetained: (dir: string): void => {
      const bus = wctx?.bus ?? workflowBus;
      if (!bus) return;
      publishWarning({
        bus,
        phase: trackedState?.phase ?? workflowPhase ?? createInitialState(feature).phase,
        message: `Isolation worktree retained at ${dir}; unpromoted work remains`,
      });
    },
    warningPublisher: (message: string): void => {
      const bus = wctx?.bus ?? workflowBus;
      if (!bus) return;
      publishWarning({
        bus,
        phase: trackedState?.phase ?? workflowPhase ?? createInitialState(feature).phase,
        message,
      });
    },
  });

  try {
    const { cancelled } = await withShutdownHandlers(
      {
        projectDir,
        sessionId,
        getTrackedState: () => trackedState,
        getCurrentTask: () => currentTask,
      },
      async () => {
        try {
          const savedStateResult =
            opts.prepared.purpose === 'new-workflow'
              ? null
              : readWorkflowStateHead({ projectDir, sessionId });
          savedState = savedStateResult?.state;
          trackedState = savedState ?? createInitialState(feature);
          const resumeHolder: ResumeContextHolder = { messages: [] };
          const init = await initializeWorkflow({
            opts,
            config,
            sessionId,
            summaryBase,
            metadata,
            setTrackedState: trackState,
            resumeHolder,
            isolation,
            savedState,
            newWorkflow: opts.prepared.purpose === 'new-workflow',
          });
          if (!init.ok) {
            workflowBus = init.bus;
            workflowPhase = init.phase;
            result = init.summary;
            sessionStatus = 'failed';
            return;
          }

          activeSession = init.prepared.session.active;
          // A seat swap re-prepared the run on a switched config; every summary
          // from here on names the seat the run is actually running.
          summaryBase = seatIdentityOf(init.prepared.config);
          workflowBus = init.wctx.bus;
          const callPublisher: PlannerCallPublisherContext = {
            bus: init.wctx.bus,
            getPhase: () => trackedState?.phase ?? createInitialState(feature).phase,
          };
          const publishingPlanner = withPlannerCallPublishing(init.wctx.planner, callPublisher);
          wctx = {
            ...init.wctx,
            planner: publishingPlanner,
            reviewer:
              init.wctx.reviewer === init.wctx.planner
                ? publishingPlanner
                : withReviewerCallPublishing(init.wctx.reviewer, callPublisher),
            setRewindFeedback: (feedback) => {
              transientRewindFeedback = feedback;
            },
          };
          trackedState = init.state;
          const phaseTimings: Record<string, number> = {};

          installQueueHandler({
            projectDir,
            sessionId,
            sinks: wctx.sinks,
            getTrackedState: () => trackedState,
            setTrackedState: trackState,
            bus: wctx.bus,
            config,
            planner: wctx.planner,
            ...(wctx.signal !== undefined && { signal: wctx.signal }),
          });

          let stateForPlanning = init.state;
          let savedStateForPlanning = savedState;
          while (true) {
            const feedbackForPlanning = transientRewindFeedback;
            transientRewindFeedback = undefined;
            const planning = await runPlanningPhases({
              wctx,
              state: stateForPlanning,
              savedState: savedStateForPlanning,
              selectedSkills,
              phaseTimings,
              startTime,
              setTrackedState: trackState,
              ...(feedbackForPlanning !== undefined && { rewindFeedback: feedbackForPlanning }),
            });
            trackState(planning.state);

            switch (planning.disposition) {
              case 'terminal':
                if (planning.outcome === 'failed') sessionStatus = 'failed';
                result = buildSummary({ ...summaryBase, state: planning.state, phaseTimings });
                return;
              case 'ready-for-tasks':
                break;
              default:
                return assertNever(planning);
            }

            if (opts.signal?.aborted) {
              result = buildSummary({ ...summaryBase, state: planning.state, phaseTimings });
              return;
            }

            const taskRun = await runTasksAndReview({
              wctx,
              state: planning.state,
              planning,
              summaryBase,
              phaseTimings,
              setTrackedState: trackState,
              setCurrentTask: (t) => {
                currentTask = t;
              },
            });
            result = taskRun.summary;
            sessionStatus = taskRun.completed ? 'complete' : 'interrupted';
            if (taskRun.cancelled) {
              publishWorkflowCancellation(WORKFLOW_CANCEL_REASON_USER);
              return;
            }
            if (
              !taskRun.completed &&
              taskRun.state.rewindPending !== undefined &&
              !opts.signal?.aborted
            ) {
              stateForPlanning = taskRun.state;
              savedStateForPlanning = taskRun.state;
              continue;
            }
            return;
          }
        } catch (err) {
          await killAllProcesses();
          if (opts.signal?.aborted) {
            sessionStatus = 'interrupted';
          } else {
            const bus = wctx?.bus ?? workflowBus;
            if (bus && trackedState) {
              publishError({ bus, phase: trackedState.phase, message: toErrorMessage(err) });
            } else {
              // A failure raised before the run has a bus has no event to carry
              // it; without this the run returns an empty summary and says
              // nothing about why.
              warnError('workflow initialization', err);
            }
            sessionStatus = 'failed';
          }
          result = buildSummary({
            ...summaryBase,
            state: trackedState ?? createInitialState(feature),
          });
        }
      },
    );

    const signalCancellationReason = workflowCancelledReasonFromSignal(opts.signal);
    if (cancelled || signalCancellationReason !== undefined) {
      publishWorkflowCancellation(signalCancellationReason ?? WORKFLOW_CANCEL_REASON_USER);
    }

    if (!result) {
      if (cancelled) {
        const summary = buildSummary({
          ...summaryBase,
          state: trackedState ?? createInitialState(feature),
        });
        saveFinalSession({
          projectDir,
          sessionId,
          active: activeSession,
          feature,
          startTime,
          status: sessionStatus,
          summary,
          preserveActive: shouldPreserveActiveState(trackedState),
        });
        return summary;
      }
      throw error('workflow-no-summary', 'Unreachable: workflow did not produce a summary');
    }
    saveFinalSession({
      projectDir,
      sessionId,
      active: activeSession,
      feature,
      startTime,
      status: sessionStatus,
      summary: result,
      preserveActive: shouldPreserveActiveState(trackedState),
    });
    return result;
  } finally {
    // Ownership-guarded: acquireLiveness's warn-and-continue escape hatches can
    // let a successor run install its ledger before this superseded run's
    // teardown executes — a bare setProcessLedger(null) would silently disable
    // the successor's runner-pid recording (and with it orphan reaping).
    clearProcessLedger(runProcessLedger);
    // A host credential bridged into the project sandbox must not outlive the
    // run that admitted it; the next run re-bridges whatever it needs.
    await clearBridgedCliState(projectDir).catch((err: unknown) => {
      warnError('sandbox bridged state cleanup', err);
    });
    // A dispose failure (e.g. git refuses to remove the worktree) is reported,
    // never allowed to escape runWorkflow.
    await isolation.dispose().catch((err: unknown) => {
      warnError('run isolation disposal', err);
    });
    await releaseLiveness();
  }
}
