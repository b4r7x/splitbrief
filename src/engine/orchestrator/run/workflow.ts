import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { Task } from '../../../core/schemas/task.js';
import type { Summary } from '../../../core/schemas/summary.js';
import type { Session } from '../../../core/schemas/session.js';
import type { SpecMetadata } from '../../../core/paths-io.js';
import { DEFAULT_WORKFLOW_MODE } from '../../../core/schemas/config.js';
import type { WorkflowMode } from '../../../core/schemas/enums.js';
import { createInitialState } from '../../../core/state/machine.js';
import { loadState, saveState } from '../../../core/state/persistence.js';
import { featureForTranscriptPolicy } from '../../../core/sessions/lifecycle.js';
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
import { sessionDir } from '../../../core/paths.js';
import { ensureSessionDir } from '../../../core/paths-io.js';
import { checkServerStatus, writeLockfile, markExited } from '../../ipc/lockfile.js';
import { startHeartbeat } from '../../ipc/heartbeat.js';
import { warnError } from '../../../lib/warn.js';
import { SPLITBRIEF_IDENTITY } from '../../../core/identity.js';

import type {
  Planner,
  PlannerCallbacks,
  PlannerCallEventCallbacks,
  PlannerOutputCallbacks,
  PlannerStructuredSummaryOptions,
  PlannerSummaryOptions,
  PlannerUserTurnOptions,
} from '../../planners/types.js';
import {
  WORKFLOW_CANCEL_REASON_USER,
  workflowCancelledReasonFromSignal,
  type ResumeContextHolder,
  type WorkflowContext,
} from '../types.js';
import { buildSummary, type SummaryBase } from '../summary/build.js';
import {
  publishError,
  publishRunnerCallEvent,
  publishWarning,
  publishWarningFromError,
} from '../events.js';
import { saveFinalSession, shouldPreserveActiveState } from '../session-lifecycle/finalize.js';
import { withShutdownHandlers } from '../session-lifecycle/shutdown.js';
import { installQueueHandler } from '../session-lifecycle/install-queue.js';
import { createRunIsolation } from '../isolation/create.js';

import { initializeWorkflow, type RunWorkflowOptions } from './init.js';
import { clearBridgedCliState } from '../../runners/sandbox-env.js';
import { getIsolationStrategy } from '../../../core/config/accessors/values.js';
import { reapOrphanRunners } from './orphan-reaper.js';
import { runPlanningPhases, runTasksAndReview } from './phases.js';

export const WORKFLOW_REWIND_ABORT_REASON = 'workflow-rewind';

type PlannerCallPublisherContext = {
  bus: WorkflowContext['bus'];
  getPhase: () => WorkflowState['phase'];
};

const workflowLivenessError = {
  sessionAlreadyLive: (sessionId: string, pid: number) =>
    error(
      'workflow-session-already-live',
      `session '${sessionId}' is already running (pid ${pid}). Use '${SPLITBRIEF_IDENTITY.executable} continue ${sessionId}' to attach or resume it.`,
      { sessionId, pid },
    ),
};

function isDetachedLivenessOwner(data: { pid: number; authToken?: string | undefined }): boolean {
  return data.pid === process.pid && data.authToken !== undefined;
}

function publishPlannerRunnerCall(
  ctx: PlannerCallPublisherContext,
  event: Parameters<typeof publishRunnerCallEvent>[1],
): void {
  publishRunnerCallEvent({ bus: ctx.bus, phase: ctx.getPhase() }, event);
}

function withPlannerCallbacks(
  callbacks: PlannerCallbacks,
  ctx: PlannerCallPublisherContext,
): PlannerCallbacks {
  if (callbacks.onCallEvent !== undefined) return callbacks;
  return {
    ...callbacks,
    onCallEvent: (event) => publishPlannerRunnerCall(ctx, event),
  };
}

function withPlannerOutputCallbacks(
  callbacks: PlannerOutputCallbacks,
  ctx: PlannerCallPublisherContext,
): PlannerOutputCallbacks {
  if (callbacks.onCallEvent !== undefined) return callbacks;
  return {
    ...callbacks,
    onCallEvent: (event) => publishPlannerRunnerCall(ctx, event),
  };
}

function withPlannerCallEventCallbacks(
  callbacks: PlannerCallEventCallbacks | undefined,
  ctx: PlannerCallPublisherContext,
): PlannerCallEventCallbacks {
  if (callbacks?.onCallEvent !== undefined) return callbacks;
  return {
    ...callbacks,
    onCallEvent: (event) => publishPlannerRunnerCall(ctx, event),
  };
}

function withPlannerSummaryOptions(
  opts: PlannerSummaryOptions | undefined,
  ctx: PlannerCallPublisherContext,
): PlannerSummaryOptions {
  return {
    ...opts,
    callbacks: withPlannerCallEventCallbacks(opts?.callbacks, ctx),
  };
}

function withPlannerStructuredSummaryOptions(
  opts: PlannerStructuredSummaryOptions | undefined,
  ctx: PlannerCallPublisherContext,
): PlannerStructuredSummaryOptions {
  return {
    ...opts,
    callbacks: withPlannerCallEventCallbacks(opts?.callbacks, ctx),
  };
}

function withPlannerUserTurnOptions(
  opts: PlannerUserTurnOptions,
  ctx: PlannerCallPublisherContext,
): PlannerUserTurnOptions {
  return {
    ...opts,
    callbacks: withPlannerCallEventCallbacks(opts.callbacks, ctx),
  };
}

function withPlannerCallPublishing(planner: Planner, ctx: PlannerCallPublisherContext): Planner {
  const wrapped: Planner = {
    isAvailable: () => planner.isAvailable(),
    getVersion: () => planner.getVersion(),
    capabilities: planner.capabilities,
    plan: (opts) =>
      planner.plan({
        ...opts,
        callbacks: withPlannerCallbacks(opts.callbacks, ctx),
      }),
    quickPlan: (opts) =>
      planner.quickPlan({
        ...opts,
        callbacks: withPlannerCallbacks(opts.callbacks, ctx),
      }),
    regenerate: (opts) =>
      planner.regenerate({
        ...opts,
        callbacks: withPlannerOutputCallbacks(opts.callbacks, ctx),
      }),
    escalateHint: (opts) =>
      planner.escalateHint({
        ...opts,
        callbacks: withPlannerOutputCallbacks(opts.callbacks, ctx),
      }),
    escalateFull: (opts) =>
      planner.escalateFull({
        ...opts,
        callbacks: withPlannerOutputCallbacks(opts.callbacks, ctx),
      }),
    review: (prompt, projectDir, callbacks) =>
      planner.review(prompt, projectDir, withPlannerOutputCallbacks(callbacks, ctx)),
    summarize: (messages, opts) =>
      planner.summarize(messages, withPlannerSummaryOptions(opts, ctx)),
  };
  const unavailabilityReason = planner.unavailabilityReason;
  if (unavailabilityReason !== undefined) {
    wrapped.unavailabilityReason = () => unavailabilityReason.call(planner);
  }
  const injectUserTurn = planner.injectUserTurn;
  if (injectUserTurn !== undefined) {
    wrapped.injectUserTurn = (opts) =>
      injectUserTurn.call(planner, withPlannerUserTurnOptions(opts, ctx));
  }
  const instantPlan = planner.instantPlan;
  if (instantPlan !== undefined) {
    wrapped.instantPlan = (opts) =>
      instantPlan.call(planner, {
        ...opts,
        callbacks: withPlannerCallbacks(opts.callbacks, ctx),
      });
  }
  const summarizeStructured = planner.summarizeStructured;
  if (summarizeStructured !== undefined) {
    wrapped.summarizeStructured = (messages, opts) =>
      summarizeStructured.call(planner, messages, withPlannerStructuredSummaryOptions(opts, ctx));
  }
  return wrapped;
}

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
}): WorkflowState | null {
  if (opts.signal?.reason !== WORKFLOW_REWIND_ABORT_REASON) return null;
  const persisted = loadState({ projectDir: opts.projectDir, sessionId: opts.sessionId });
  return persisted?.rewindPending !== undefined ? persisted : null;
}

// Every run (TUI, headless, RPC) writes a liveness lockfile + heartbeat so checkServerStatus
// can see an in-flight interactive run and refuse a concurrent resume/continue. The detached
// server already owns an authenticated lockfile for the session; do not clobber it.
async function acquireLiveness(opts: {
  projectDir: string;
  sessionId: string;
  feature: string;
  mode: WorkflowMode;
  persistTranscript: boolean;
  signal?: AbortSignal | undefined;
}): Promise<() => Promise<void>> {
  const dir = sessionDir(opts.projectDir, opts.sessionId);
  ensureSessionDir(opts.projectDir, opts.sessionId);
  let status: Awaited<ReturnType<typeof checkServerStatus>>;
  try {
    status = await checkServerStatus(dir);
  } catch (err) {
    if (opts.signal?.aborted) return async () => {};
    warnError('Failed to inspect session liveness lockfile', err);
    return async () => {};
  }
  if (status.alive) {
    if (isDetachedLivenessOwner(status.data)) return async () => {};
    throw workflowLivenessError.sessionAlreadyLive(opts.sessionId, status.data.pid);
  }

  try {
    const now = Date.now();
    await writeLockfile(dir, {
      pid: process.pid,
      startTimeMs: now,
      lastAliveMs: now,
      sessionId: opts.sessionId,
      mode: opts.mode,
      feature: featureForTranscriptPolicy(opts.feature, opts.persistTranscript),
    });
    const stopHeartbeat = startHeartbeat(dir);
    return async () => {
      stopHeartbeat();
      try {
        await markExited(dir, 0);
      } catch (err) {
        warnError('Failed to mark session exited', err);
      }
    };
  } catch (err) {
    if (opts.signal?.aborted) return async () => {};
    warnError('Failed to acquire session liveness lockfile', err);
    return async () => {};
  }
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
  const savedState = opts.savedState ?? runtime.resumeState;
  const { selectedSkills } = opts;
  // A boundary interrupt raised before this run started (Esc-Esc in a dead zone
  // of a previous run that then ended into recovery without passing a call
  // boundary) is stale: drain it so it cannot park this run's first call
  // boundary on an interrupt nobody requested.
  opts.sinks.consumeBoundaryInterrupt?.();
  const startTime = resolveSessionStart(savedState);
  const ident = runPricingIdentity(config);
  const persistTranscript = config.workflow.persistTranscript;
  const plannerTool = savedState?.plannerTool ?? ident.plannerTool;
  const plannerModel = savedState?.plannerModel ?? ident.plannerModel;
  const implementerTool = savedState?.implementerTool ?? ident.implementerTool;
  const implementerModel = savedState?.implementerModel ?? ident.implementerModel;
  const summaryBase: SummaryBase = {
    feature,
    startTime,
    plannerTool,
    ...(plannerModel !== undefined && { plannerModel }),
    implementerTool,
    ...(implementerModel !== undefined && { implementerModel }),
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

  let trackedState: WorkflowState | undefined = savedState;
  let currentTask: Pick<Task, 'file' | 'action'> | undefined;
  let result: Summary | undefined;
  let sessionStatus: Session['status'] = 'interrupted';
  let wctx: WorkflowContext | undefined;
  let workflowBus: WorkflowContext['bus'] | undefined;
  let workflowPhase: WorkflowState['phase'] | undefined;
  let cancellationPublished = false;
  let transientRewindFeedback = opts.rewindFeedback;

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
          const resumeHolder: ResumeContextHolder = { messages: [] };
          const init = await initializeWorkflow({
            opts,
            config,
            sessionId,
            summaryBase,
            metadata,
            setTrackedState: (s) => {
              trackedState = s;
            },
            resumeHolder,
            isolation,
          });
          if (!init.ok) {
            workflowBus = init.bus;
            workflowPhase = init.phase;
            result = init.summary;
            sessionStatus = 'failed';
            return;
          }

          workflowBus = init.wctx.bus;
          wctx = {
            ...init.wctx,
            planner: withPlannerCallPublishing(init.wctx.planner, {
              bus: init.wctx.bus,
              getPhase: () => trackedState?.phase ?? createInitialState(feature).phase,
            }),
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
            setTrackedState: (s) => {
              trackedState = s;
            },
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
              setTrackedState: (s) => {
                trackedState = s;
              },
              ...(feedbackForPlanning !== undefined && { rewindFeedback: feedbackForPlanning }),
            });
            if (planning.cancelled) {
              if (planning.failed) sessionStatus = 'failed';
              result = buildSummary({ ...summaryBase, state: planning.state, phaseTimings });
              return;
            }

            if (opts.signal?.aborted) {
              result = buildSummary({ ...summaryBase, state: planning.state, phaseTimings });
              return;
            }

            const taskRun = await runTasksAndReview({
              wctx,
              state: planning.state,
              summaryBase,
              phaseTimings,
              setTrackedState: (s) => {
                trackedState = s;
              },
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
          const persistedRewindState = loadPersistedRewindState({
            projectDir,
            sessionId,
            signal: opts.signal,
          });
          if (persistedRewindState) {
            trackedState = persistedRewindState;
          } else if (trackedState) {
            try {
              saveState({ projectDir, sessionId }, trackedState);
            } catch (saveErr) {
              if (wctx)
                publishWarningFromError(
                  { bus: wctx.bus, phase: trackedState.phase },
                  'Failed to save state',
                  saveErr,
                );
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
    await releaseLiveness();
  }
}
