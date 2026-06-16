import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { Task } from '../../../core/schemas/task.js';
import type { Summary } from '../../../core/schemas/summary.js';
import type { Session } from '../../../core/schemas/session.js';
import type { SpecMetadata } from '../../../core/paths-io.js';
import { DEFAULT_WORKFLOW_MODE } from '../../../core/schemas/config.js';
import type { WorkflowMode } from '../../../core/schemas/enums.js';
import { createInitialState } from '../../../core/state/machine.js';
import { saveState } from '../../../core/state/persistence.js';
import { generateSessionId, writeActive } from '../../../core/sessions/lifecycle.js';
import { runPricingIdentity } from '../../../core/providers/pricing-identity.js';
import { killAllProcesses } from '../../../lib/process/registry.js';
import { toErrorMessage } from '../../../utils/format-errors.js';
import { error } from '../../../utils/error.js';
import { sessionDir } from '../../../core/paths.js';
import { ensureSessionDir } from '../../../core/paths-io.js';
import { checkServerStatus, writeLockfile, markExited } from '../../ipc/lockfile.js';
import { startHeartbeat } from '../../ipc/heartbeat.js';
import { warnError } from '../../../lib/warn.js';

import type { ResumeContextHolder, WorkflowContext } from '../types.js';
import { buildSummary, type SummaryBase } from '../summary.js';
import { publishError, publishWarningFromError } from '../events.js';
import {
  saveFinalSession,
  shouldPreserveActiveState,
  withShutdownHandlers,
  installQueueHandler,
} from '../session-lifecycle.js';

import { initializeWorkflow, type RunWorkflowOptions } from './init.js';
import { runPlanningPhases, runTasksAndReview } from './phases.js';

export const WORKFLOW_REWIND_ABORT_REASON = 'workflow-rewind';

function shouldPreserveActiveSession(
  state: WorkflowState | undefined,
  signal: AbortSignal | undefined,
): boolean {
  return (
    signal?.reason === WORKFLOW_REWIND_ABORT_REASON || shouldPreserveActiveState(state ?? null)
  );
}

// Every run (TUI, headless, RPC) writes a liveness lockfile + heartbeat so checkServerStatus
// can see an in-flight interactive run and refuse a concurrent resume/continue. The detached
// server already owns an authenticated lockfile for the session; do not clobber it.
async function acquireLiveness(opts: {
  projectDir: string;
  sessionId: string;
  feature: string;
  mode: WorkflowMode;
  signal?: AbortSignal | undefined;
}): Promise<() => Promise<void>> {
  const dir = sessionDir(opts.projectDir, opts.sessionId);
  ensureSessionDir(opts.projectDir, opts.sessionId);
  try {
    const status = await checkServerStatus(dir);
    if (status.alive) return async () => {};
    const now = Date.now();
    await writeLockfile(dir, {
      pid: process.pid,
      startTimeMs: now,
      lastAliveMs: now,
      sessionId: opts.sessionId,
      mode: opts.mode,
      feature: opts.feature,
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
  const { feature, projectDir, config, savedState, selectedSkills } = opts;
  const startTime = resolveSessionStart(savedState);
  const ident = runPricingIdentity(config);
  const sessionId = opts.sessionId ?? generateSessionId(projectDir, feature);
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

  const releaseLiveness = await acquireLiveness({
    projectDir,
    sessionId,
    feature,
    mode: config.workflow.mode ?? DEFAULT_WORKFLOW_MODE,
    signal: opts.signal,
  });

  writeActive({ projectDir, sessionId });

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
            sessionId,
            summaryBase,
            metadata,
            setTrackedState: (s) => {
              trackedState = s;
            },
            resumeHolder,
          });
          if (!init.ok) {
            result = init.summary;
            return;
          }

          wctx = init.wctx;
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
          });

          const planning = await runPlanningPhases({
            wctx,
            state: init.state,
            savedState,
            selectedSkills,
            phaseTimings,
            startTime,
            setTrackedState: (s) => {
              trackedState = s;
            },
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
        } catch (err) {
          if (trackedState) {
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
          killAllProcesses();
          if (opts.signal?.aborted) {
            sessionStatus = 'interrupted';
          } else {
            if (wctx && trackedState)
              publishError({ bus: wctx.bus, phase: trackedState.phase }, toErrorMessage(err));
            sessionStatus = 'failed';
          }
          result = buildSummary({
            ...summaryBase,
            state: trackedState ?? createInitialState(feature),
          });
        }
      },
    );

    if (cancelled && wctx) {
      wctx.bus.publish({
        type: 'workflow_cancelled',
        ts: Date.now(),
        phase: trackedState?.phase ?? createInitialState(feature).phase,
      });
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
          feature,
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
      feature,
      startTime,
      status: sessionStatus,
      summary: result,
      preserveActive: shouldPreserveActiveSession(trackedState, opts.signal),
    });
    return result;
  } finally {
    await releaseLiveness();
  }
}
