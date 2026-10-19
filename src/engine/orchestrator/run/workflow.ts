import { existsSync } from 'node:fs';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { retentionError } from '../isolation/retention.js';
import type { Task } from '../../../core/schemas/task.js';
import type { Summary } from '../../../core/schemas/summary.js';
import type { SpecMetadata } from '../../../core/paths-io.js';
import type { Config } from '../../../core/schemas/config.js';
import { createInitialState } from '../../../core/state/machine.js';
import { pruneOrphanSessions } from '../../../core/sessions/orphans.js';
import { recordRunnerPid, releaseRunnerPid } from '../../../core/sessions/runner-pids.js';
import { runSeatIdentity } from '../../../core/providers/seat-identity.js';
import { resolveSpecMetadata } from '../../providers/model/display-names.js';
import { NULL_CACHE } from '../../providers/model/resolution.js';
import {
  clearProcessLedger,
  killAllProcesses,
  setProcessLedger,
} from '../../../lib/process/registry.js';
import { toErrorMessage } from '../../../utils/format-errors.js';
import { nowIso } from '../../../utils/format-time.js';
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
import { reopenSessionRecord, saveFinalSession } from '../session-lifecycle/finalize.js';
import { withShutdownHandlers } from '../session-lifecycle/shutdown.js';
import { installQueueHandler } from '../session-lifecycle/install-queue.js';
import { createRunIsolation } from '../isolation/create.js';

import { type RunWorkflowOptions, initializeWorkflow } from './init.js';
import { clearBridgedCliState } from '../../runners/sandbox-state-bridge.js';
import { getIsolationStrategy } from '../../../core/config/accessors/values.js';
import { reapOrphanRunners } from './orphan-reaper.js';
import { runPlanningPhases } from './phases.js';
import { runTasksAndReview } from './task-execution.js';
import { recordCheckoutRunSnapshot } from './snapshots.js';
import {
  withPlannerCallPublishing,
  withReviewerCallPublishing,
  type PlannerCallPublisherContext,
} from './call-publishing.js';
import { acquireLiveness } from './liveness.js';
import { closeRunIfOpen, userStopStoppedWork } from './close.js';
import {
  followCommittedState,
  parkStoppedRun,
  readWorkflowStateHead,
  rebaseOnPersistedWorkflowState,
  recordLastFailure,
} from '../state-ops.js';
import { sessionDir } from '../../../core/paths.js';
import { resumeStep } from '../../../core/sessions/run-status.js';
import { createSteeringPort } from '../../calls/steering.js';
import { seatForRunningCall } from '../../../core/runners/seat-roles.js';

function resolveSessionStart(savedState: WorkflowState | undefined): number {
  if (!savedState) return Date.now();
  const original = Date.parse(savedState.startedAt);
  return Number.isNaN(original) ? Date.now() : original;
}

/**
 * A new-workflow run applies START, which the state machine accepts only from
 * `idle`. `prepareNewSession` allocates a session directory that cannot already
 * exist (a non-recursive mkdir plus an exclusive ownership marker), so a
 * new-workflow preparation serves only the run that starts its session. Every
 * later entry into that session is a resume: the TUI run loop prepares the
 * session again as `purpose: 'resume'` before it re-enters a run it started (a
 * halt answered in process, a rewind, a restart), and a seat swap, a continue at
 * rest and the CLI `continue` are resume preparations already. Refusing before
 * the run touches liveness, isolation, or state keeps a caller that breaks this
 * rule an internal invariant instead of a transition error raised half-way into
 * a session it then marks failed.
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
    const ident = runSeatIdentity(source);
    return {
      feature,
      startTime,
      plannerTool: ident.plannerTool,
      ...(ident.plannerModel !== undefined && { plannerModel: ident.plannerModel }),
      ...(ident.plannerKind !== undefined && { plannerKind: ident.plannerKind }),
      implementerTool: ident.implementerTool,
      ...(ident.implementerModel !== undefined && { implementerModel: ident.implementerModel }),
      ...(ident.implementerKind !== undefined && { implementerKind: ident.implementerKind }),
      ...(ident.reviewerTool !== undefined && { reviewerTool: ident.reviewerTool }),
      ...(ident.reviewerModel !== undefined && { reviewerModel: ident.reviewerModel }),
      ...(ident.reviewerKind !== undefined && { reviewerKind: ident.reviewerKind }),
      projectDir,
      sessionId,
      ...(opts.modelCache !== undefined && { pricingCache: opts.modelCache }),
    };
  };
  const summaryBase = seatIdentityOf(config);

  const metadata: SpecMetadata = resolveSpecMetadata(config, opts.modelCache ?? NULL_CACHE);

  let trackedState: WorkflowState | undefined;
  let currentTask: Pick<Task, 'suggestedFiles' | 'action'> | undefined;
  let result: Summary | undefined;
  let wctx: WorkflowContext | undefined;
  let workflowBus: WorkflowContext['bus'] | undefined;
  let workflowPhase: WorkflowState['phase'] | undefined;
  let cancellationPublished = false;

  const trackState = (state: WorkflowState): void => {
    trackedState = state;
  };

  // Why the run stopped belongs on the state, not in a status the exit path picks:
  // the session record and every resume decision derive from it afterwards.
  const recordFailure = (state: WorkflowState, message: string): WorkflowState =>
    recordLastFailure({ projectDir, sessionId }, state, {
      step: resumeStep(state),
      message,
      at: nowIso(),
    });

  // Every other abort parks the step it cut, so the run reads `open · paused`.
  // A crash that never reached this point still reads `interrupted`, which is
  // the honest answer for a run that had no chance to say where it stopped.
  const parkRun = async (state: WorkflowState): Promise<WorkflowState> => {
    const latest = rebaseOnPersistedWorkflowState({ projectDir, sessionId }, state);
    if (
      latest.closed !== undefined ||
      latest.phase === 'complete' ||
      latest.interruptedStep !== undefined ||
      latest.pendingRecovery !== undefined
    ) {
      return latest;
    }
    return parkStoppedRun({ projectDir, sessionId, bus: wctx?.bus ?? workflowBus }, latest);
  };

  const publishWorkflowCancellation = (reason: typeof WORKFLOW_CANCEL_REASON_USER): void => {
    const bus = wctx?.bus ?? workflowBus;
    if (!bus || cancellationPublished) return;
    if (trackedState !== undefined && !userStopStoppedWork(trackedState)) return;
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

  let stopFollowingState: (() => void) | undefined;
  try {
    // A head a nested call commits reaches the tracked state too, so no event is stamped with
    // the phase the run has already left.
    stopFollowingState = followCommittedState(ref, trackState);
    const { cancelled } = await withShutdownHandlers(
      {
        projectDir,
        sessionId,
        getTrackedState: () => trackedState,
        getCurrentTask: () => currentTask,
      },
      async () => {
        try {
          // Read progress after acquisition: the previous runner may have finished while orphan
          // cleanup was awaiting.
          savedState =
            opts.prepared.purpose === 'new-workflow'
              ? undefined
              : readWorkflowStateHead({ projectDir, sessionId })?.state;
          if (opts.prepared.purpose !== 'new-workflow') reopenSessionRecord(ref);
          trackedState = savedState ?? createInitialState(feature);
          const resumeHolder: ResumeContextHolder = { messages: [] };
          const init = await initializeWorkflow({
            opts,
            config,
            sessionId,
            summaryBase,
            metadata,
            setTrackedState: trackState,
            getTrackedState: () => trackedState,
            resumeHolder,
            isolation,
            savedState,
            newWorkflow: opts.prepared.purpose === 'new-workflow',
          });
          if (!init.ok) {
            workflowBus = init.bus;
            workflowPhase = init.phase;
            result = init.summary;
            return;
          }

          workflowBus = init.wctx.bus;
          const callPublisher: PlannerCallPublisherContext = {
            bus: init.wctx.bus,
            getPhase: () => trackedState?.phase ?? createInitialState(feature).phase,
          };
          const publishingPlanner = withPlannerCallPublishing(init.wctx.planner, callPublisher);
          const steering = createSteeringPort({
            onChange: (call) => {
              const seat = call === null ? null : seatForRunningCall(call);
              init.wctx.bus.publish({
                type: 'steerable_call',
                ts: Date.now(),
                phase: trackedState?.phase ?? init.state.phase,
                ...(seat !== null && { seat }),
                ...(call !== null && call.taskId !== null && { taskId: call.taskId }),
              });
            },
          });
          wctx = {
            ...init.wctx,
            steering,
            planner: publishingPlanner,
            reviewer:
              init.wctx.reviewer === init.wctx.planner
                ? publishingPlanner
                : withReviewerCallPublishing(init.wctx.reviewer, callPublisher),
          };
          trackedState = init.state;

          installQueueHandler({
            projectDir,
            sessionId,
            sinks: wctx.sinks,
            getTrackedState: () => trackedState,
            setTrackedState: trackState,
            bus: wctx.bus,
            config,
            planner: wctx.planner,
            modelCache: wctx.modelCache,
            steering,
            ...(wctx.signal !== undefined && { signal: wctx.signal }),
          });

          const planning = await runPlanningPhases({
            wctx,
            state: init.state,
            savedState,
            setTrackedState: trackState,
          });
          trackState(planning.state);

          switch (planning.disposition) {
            case 'terminal':
              if (planning.outcome === 'failed') {
                trackState(recordFailure(planning.state, 'Planning failed.'));
              }
              result = buildSummary({ ...summaryBase, state: planning.state });
              return;
            case 'ready-for-tasks':
              break;
            default:
              return assertNever(planning);
          }

          if (opts.signal?.aborted) {
            result = buildSummary({ ...summaryBase, state: planning.state });
            return;
          }

          const taskRun = await runTasksAndReview({
            wctx,
            state: planning.state,
            planning,
            summaryBase,
            setTrackedState: trackState,
            setCurrentTask: (t) => {
              currentTask = t;
            },
          });
          result = taskRun.summary;
        } catch (err) {
          await killAllProcesses();
          if (!opts.signal?.aborted || retentionError.isFailed(err)) {
            const bus = wctx?.bus ?? workflowBus;
            const message = toErrorMessage(err);
            if (bus && trackedState) {
              publishError({ bus, phase: trackedState.phase, message });
            } else {
              // A failure raised before the run has a bus has no event to carry
              // it; without this the run returns an empty summary and says
              // nothing about why.
              warnError('workflow initialization', err);
            }
            if (trackedState) trackedState = recordFailure(trackedState, message);
          }
          result = buildSummary({
            ...summaryBase,
            state: trackedState ?? createInitialState(feature),
          });
        }
      },
    );

    // Every way out of the run body ends the same way: nothing it spawned outlives it, and the
    // summary lands only once those processes are gone — a child still running when the summary
    // appears could read a record of a run it is still part of.
    await killAllProcesses();

    const signalCancellationReason = workflowCancelledReasonFromSignal(opts.signal);
    const stoppedState = trackedState;
    if (stoppedState !== undefined) {
      if (signalCancellationReason !== undefined) {
        const closure = await closeRunIfOpen(
          { projectDir, sessionId, bus: wctx?.bus ?? workflowBus },
          stoppedState,
        );
        trackedState = closure.state;
        if (result !== undefined && result.phase !== closure.state.phase) {
          result = { ...result, phase: closure.state.phase };
        }
        if (closure.closedNow) publishWorkflowCancellation(signalCancellationReason);
      } else if (opts.signal?.aborted) {
        trackedState = await parkRun(stoppedState);
      }
    }
    if (cancelled && signalCancellationReason === undefined) {
      publishWorkflowCancellation(WORKFLOW_CANCEL_REASON_USER);
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
          active: session.active,
          feature,
          startTime,
          summary,
          state: trackedState,
        });
        return summary;
      }
      throw error('workflow-no-summary', 'Unreachable: workflow did not produce a summary');
    }
    saveFinalSession({
      projectDir,
      sessionId,
      active: session.active,
      feature,
      startTime,
      summary: result,
      state: trackedState,
    });
    return result;
  } finally {
    stopFollowingState?.();
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
    // Disposal settles the last attempt revert, so this is the checkout as the run left it.
    const restingBus = wctx?.bus ?? workflowBus;
    if (restingBus !== undefined && trackedState !== undefined) {
      await recordCheckoutRunSnapshot({
        projectDir,
        sessionId,
        bus: restingBus,
        state: trackedState,
      });
    }
    await releaseLiveness();
  }
}
