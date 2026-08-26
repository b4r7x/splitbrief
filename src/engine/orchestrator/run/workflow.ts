import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { Task } from '../../../core/schemas/task.js';
import type { Summary } from '../../../core/schemas/summary.js';
import type { Session } from '../../../core/schemas/session.js';
import type { SpecMetadata } from '../../../core/paths-io.js';
import { DEFAULT_WORKFLOW_MODE } from '../../../core/schemas/config.js';
import { createInitialState } from '../../../core/state/machine.js';
import type { StateAuthorityReceipt, ResumeLoadAuthority } from '../../../core/state/types.js';
import { releaseStateAuthority } from '../../../core/state/authority.js';
import { loadStateForResume } from '../../../core/state/persistence.js';
import { featureForTranscriptPolicy } from '../../../core/sessions/session-id.js';
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

import {
  attachWorkflowAuthority,
  refreshWorkflowAuthority,
  type WorkflowAuthorityHolder,
} from './authority.js';
import { type RunWorkflowOptions, initializeWorkflow } from './init.js';
import { clearBridgedCliState } from '../../runners/sandbox-env.js';
import { getIsolationStrategy } from '../../../core/config/accessors/values.js';
import { reapOrphanRunners } from './orphan-reaper.js';
import { runPlanningPhases } from './phases.js';
import { runTasksAndReview } from './task-execution.js';
import { acquireAuthoritativeWorkflowState } from './authoritative-state.js';
import {
  withPlannerCallPublishing,
  withReviewerCallPublishing,
  type PlannerCallPublisherContext,
} from './call-publishing.js';
import { acquireLiveness } from './liveness.js';
import { createWorkflowRecoveryBinding } from './recovery-binding.js';
import { readWorkflowStateHead } from '../state-ops.js';
import { matchesPersistedExecutionPermit, parkedPlanningResult } from '../planning/handoff.js';

export const WORKFLOW_REWIND_ABORT_REASON = 'workflow-rewind';

function shouldPreserveActiveSession(
  state: WorkflowState | undefined,
  signal: AbortSignal | undefined,
): boolean {
  return (
    signal?.reason === WORKFLOW_REWIND_ABORT_REASON || shouldPreserveActiveState(state ?? null)
  );
}

function loadPersistedRewindState(opts: {
  projectDir: string;
  sessionId: string;
  signal: AbortSignal | undefined;
  authority: StateAuthorityReceipt | undefined;
}): WorkflowState | null {
  if (opts.signal?.reason !== WORKFLOW_REWIND_ABORT_REASON || opts.authority === undefined)
    return null;
  const authority: ResumeLoadAuthority = {
    kind: 'fenced',
    receipt: opts.authority,
    promotedFromVersion: null,
  };
  const loaded = loadStateForResume({
    ref: { projectDir: opts.projectDir, sessionId: opts.sessionId },
    authority,
  });
  if (loaded.kind !== 'loaded') return null;
  return loaded.state.rewindPending !== undefined ? loaded.state : null;
}

function resolveSessionStart(savedState: WorkflowState | undefined): number {
  if (!savedState) return Date.now();
  const original = Date.parse(savedState.startedAt);
  return Number.isNaN(original) ? Date.now() : original;
}

export async function runWorkflow(opts: RunWorkflowOptions): Promise<Summary> {
  const { runtime, session } = opts.prepared;
  const config = opts.prepared.config;
  const feature = runtime.feature;
  const projectDir = session.ref.projectDir;
  const sessionId = session.ref.sessionId;
  const requestedSavedState = opts.savedState ?? runtime.resumeState;
  let savedState: WorkflowState | undefined;
  const { selectedSkills } = opts;
  // A boundary interrupt raised before this run started (Esc-Esc in a dead zone
  // of a previous run that then ended into recovery without passing a call
  // boundary) is stale: drain it so it cannot park this run's first call
  // boundary on an interrupt nobody requested.
  opts.sinks.consumeBoundaryInterrupt?.();
  const startTime = resolveSessionStart(requestedSavedState);
  const ident = runPricingIdentity(config);
  const persistTranscript = config.workflow.persistTranscript;
  const plannerTool = requestedSavedState?.plannerTool ?? ident.plannerTool;
  const plannerModel = requestedSavedState?.plannerModel ?? ident.plannerModel;
  const implementerTool = requestedSavedState?.implementerTool ?? ident.implementerTool;
  const implementerModel = requestedSavedState?.implementerModel ?? ident.implementerModel;
  const reviewerTool = requestedSavedState?.reviewerTool ?? ident.reviewerTool;
  const reviewerModel = requestedSavedState?.reviewerModel ?? ident.reviewerModel;
  const summaryBase: SummaryBase = {
    feature,
    startTime,
    plannerTool,
    ...(plannerModel !== undefined && { plannerModel }),
    implementerTool,
    ...(implementerModel !== undefined && { implementerModel }),
    ...(reviewerTool !== undefined && { reviewerTool }),
    ...(reviewerModel !== undefined && { reviewerModel }),
    mode: config.workflow.mode ?? DEFAULT_WORKFLOW_MODE,
    projectDir,
    sessionId,
    persistTranscript,
    ...(opts.modelCache !== undefined && { pricingCache: opts.modelCache }),
  };

  const metadata: SpecMetadata = {
    plannerTool: summaryBase.plannerTool,
    plannerModel: summaryBase.plannerModel,
    implementerTool: summaryBase.implementerTool,
    implementerModel: summaryBase.implementerModel,
    mode: config.workflow.mode ?? DEFAULT_WORKFLOW_MODE,
  };

  let trackedState: WorkflowState | undefined;
  let currentTask: Pick<Task, 'file' | 'action'> | undefined;
  let result: Summary | undefined;
  let sessionStatus: Session['status'] = 'interrupted';
  let wctx: WorkflowContext | undefined;
  let workflowBus: WorkflowContext['bus'] | undefined;
  let workflowPhase: WorkflowState['phase'] | undefined;
  let cancellationPublished = false;
  let transientRewindFeedback = opts.rewindFeedback;
  let stateAuthority: StateAuthorityReceipt | undefined;
  let authorityHolder: WorkflowAuthorityHolder | undefined;

  const trackState = (state: WorkflowState): void => {
    trackedState = state;
    if (
      stateAuthority === undefined ||
      authorityHolder === undefined ||
      (state.stateRevision ?? 0) === authorityHolder.current.stateRevision
    ) {
      return;
    }
    authorityHolder.current = refreshWorkflowAuthority(
      { projectDir, sessionId },
      authorityHolder.current,
      state,
    );
    stateAuthority = authorityHolder.current;
    if (wctx !== undefined) attachWorkflowAuthority(wctx, stateAuthority);
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
    persistTranscript,
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
        authority: () => authorityHolder?.current,
      },
      async () => {
        try {
          const authoritative = acquireAuthoritativeWorkflowState({
            projectDir,
            sessionId,
            feature,
            purpose: opts.prepared.purpose === 'new-workflow' ? 'new-workflow' : 'resume',
          });
          stateAuthority = authoritative.authority;
          authorityHolder = { current: authoritative.authority };
          savedState = authoritative.newWorkflow ? undefined : authoritative.state;
          trackedState = authoritative.state;
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
            authority: authoritative.authority,
            authorityHolder,
            savedState: authoritative.state,
            newWorkflow: authoritative.newWorkflow,
          });
          if (!init.ok) {
            workflowBus = init.bus;
            workflowPhase = init.phase;
            result = init.summary;
            sessionStatus = 'failed';
            return;
          }

          workflowBus = init.wctx.bus;
          const callPublisher: PlannerCallPublisherContext = {
            bus: init.wctx.bus,
            getPhase: () => trackedState?.phase ?? createInitialState(feature).phase,
          };
          const publishingPlanner = withPlannerCallPublishing(init.wctx.planner, callPublisher);
          wctx = attachWorkflowAuthority(
            {
              ...init.wctx,
              planner: publishingPlanner,
              reviewer:
                init.wctx.reviewer === init.wctx.planner
                  ? publishingPlanner
                  : withReviewerCallPublishing(init.wctx.reviewer, callPublisher),
              setRewindFeedback: (feedback) => {
                transientRewindFeedback = feedback;
              },
            },
            authorityHolder.current,
          );
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

          const recoveryOwner = authorityHolder;
          const workflowContext = wctx;
          const createRecovery = () =>
            createWorkflowRecoveryBinding({
              wctx: workflowContext,
              getState: () => trackedState ?? init.state,
              setState: (s) => {
                trackedState = s;
                recoveryOwner.current = refreshWorkflowAuthority(
                  { projectDir, sessionId },
                  recoveryOwner.current,
                  s,
                );
                stateAuthority = recoveryOwner.current;
                attachWorkflowAuthority(workflowContext, stateAuthority);
              },
              getAuthority: () => recoveryOwner.current,
            });
          let recovery = createRecovery();

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
              recovery: recovery,
              ...(feedbackForPlanning !== undefined && { rewindFeedback: feedbackForPlanning }),
            });
            const handoff =
              planning.disposition === 'ready-for-tasks'
                ? matchesPersistedExecutionPermit(planning, planning.state)
                  ? planning
                  : parkedPlanningResult(sessionId, planning.state, recovery.projection)
                : planning;
            trackState(handoff.state);

            switch (handoff.disposition) {
              case 'terminal':
                if (handoff.outcome === 'failed') sessionStatus = 'failed';
                result = buildSummary({ ...summaryBase, state: handoff.state, phaseTimings });
                return;
              case 'parked':
                result = buildSummary({ ...summaryBase, state: handoff.state, phaseTimings });
                return;
              case 'ready-for-tasks':
                break;
              default:
                return assertNever(handoff);
            }

            if (opts.signal?.aborted) {
              result = buildSummary({ ...summaryBase, state: handoff.state, phaseTimings });
              return;
            }

            const taskRun = await runTasksAndReview({
              wctx,
              state: handoff.state,
              planning: handoff,
              summaryBase,
              phaseTimings,
              setTrackedState: trackState,
              setCurrentTask: (t) => {
                currentTask = t;
              },
              recovery: recovery,
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
              recovery = createRecovery();
              continue;
            }
            return;
          }
        } catch (err) {
          await killAllProcesses();
          let rewindAuthorityRefreshed = false;
          if (
            opts.signal?.reason === WORKFLOW_REWIND_ABORT_REASON &&
            stateAuthority !== undefined &&
            authorityHolder !== undefined
          ) {
            const persisted = (() => {
              try {
                return readWorkflowStateHead({ projectDir, sessionId });
              } catch {
                return null;
              }
            })();
            const persistedFence = persisted?.state.stateFence;
            if (
              persisted?.state.rewindPending !== undefined &&
              (persisted.state.stateRevision ?? 0) >= stateAuthority.stateRevision &&
              persistedFence?.token === stateAuthority.fence &&
              persistedFence.ownerId === stateAuthority.ownerId
            ) {
              authorityHolder.current = refreshWorkflowAuthority(
                { projectDir, sessionId },
                authorityHolder.current,
                persisted.state,
              );
              stateAuthority = authorityHolder.current;
              rewindAuthorityRefreshed = true;
            }
          }
          const persistedRewindState = loadPersistedRewindState({
            projectDir,
            sessionId,
            signal: opts.signal,
            authority: stateAuthority,
          });
          if (persistedRewindState) {
            trackedState = persistedRewindState;
            if (
              !rewindAuthorityRefreshed &&
              stateAuthority !== undefined &&
              authorityHolder !== undefined
            ) {
              authorityHolder.current = refreshWorkflowAuthority(
                { projectDir, sessionId },
                authorityHolder.current,
                persistedRewindState,
              );
              stateAuthority = authorityHolder.current;
            }
          }
          if (opts.signal?.aborted) {
            sessionStatus = 'interrupted';
          } else {
            if (wctx && trackedState)
              publishError({
                bus: wctx.bus,
                phase: trackedState.phase,
                message: toErrorMessage(err),
              });
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
          active: session.active,
          feature: featureForTranscriptPolicy(feature, persistTranscript),
          startTime,
          status: sessionStatus,
          summary,
          preserveActive: shouldPreserveActiveSession(trackedState, opts.signal),
        });
        return summary;
      }
      throw error('workflow-no-summary', 'Unreachable: workflow did not produce a summary');
    }
    saveFinalSession({
      projectDir,
      sessionId,
      active: session.active,
      feature: featureForTranscriptPolicy(feature, persistTranscript),
      startTime,
      status: sessionStatus,
      summary: result,
      preserveActive: shouldPreserveActiveSession(trackedState, opts.signal),
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
    if (stateAuthority !== undefined) {
      try {
        if (trackedState !== undefined) trackState(trackedState);
        releaseStateAuthority({ projectDir, sessionId }, stateAuthority);
      } catch (err) {
        warnError('workflow state authority cleanup', err);
      }
    }
    await releaseLiveness();
  }
}
