import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { Task } from '../../../core/schemas/task.js';
import type { Summary } from '../../../core/schemas/summary.js';
import type { Session } from '../../../core/schemas/session.js';
import type { SpecMetadata } from '../../../core/paths-io.js';
import { DEFAULT_WORKFLOW_MODE } from '../../../core/schemas/config.js';
import { createInitialState } from '../../../core/state/machine.js';
import { saveState } from '../../../core/state/persistence.js';
import { generateSessionId } from '../../../core/sessions/lifecycle.js';
import { runPricingIdentity } from '../../../core/providers/pricing-identity.js';
import { killAllProcesses } from '../../../lib/process/registry.js';
import { toErrorMessage } from '../../../utils/format-errors.js';
import { error } from '../../../utils/error.js';

import type { ResumeContextHolder, WorkflowContext } from '../types.js';
import { buildSummary, type SummaryBase } from '../summary.js';
import { publishError, publishWarningFromError } from '../events.js';
import {
  saveFinalSession,
  withShutdownHandlers,
  installQueueHandler,
} from '../session-lifecycle.js';

import { initializeWorkflow, type RunWorkflowOptions } from './init.js';
import { runPlanningPhases, runTasksAndReview, applyPostPlanDrain } from './phases.js';

export const WORKFLOW_REWIND_ABORT_REASON = 'workflow-rewind';

function shouldPreserveActiveSession(
  state: WorkflowState | undefined,
  signal: AbortSignal | undefined,
): boolean {
  return state?.pendingRecovery !== undefined || signal?.reason === WORKFLOW_REWIND_ABORT_REASON;
}

export async function runWorkflow(opts: RunWorkflowOptions): Promise<Summary> {
  const { feature, projectDir, config, savedState, selectedSkills } = opts;
  const startTime = Date.now();
  const ident = runPricingIdentity(config);
  const sessionId = opts.sessionId ?? generateSessionId(projectDir, feature);
  const summaryBase: SummaryBase = {
    feature,
    startTime,
    plannerTool: ident.plannerTool,
    ...(ident.plannerModel !== undefined && { plannerModel: ident.plannerModel }),
    implementerTool: ident.implementerTool,
    ...(ident.implementerModel !== undefined && { implementerModel: ident.implementerModel }),
    mode: config.workflow.mode ?? DEFAULT_WORKFLOW_MODE,
    projectDir,
    sessionId,
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
          result = buildSummary({ ...summaryBase, state: planning.state, phaseTimings });
          return;
        }

        if (opts.signal?.aborted) {
          result = buildSummary({ ...summaryBase, state: planning.state, phaseTimings });
          return;
        }

        const postPlanState = applyPostPlanDrain({
          ctx: wctx,
          state: planning.state,
          setTrackedState: (s) => {
            trackedState = s;
          },
        });

        const taskRun = await runTasksAndReview({
          wctx,
          state: postPlanState,
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
            saveState(projectDir, sessionId, trackedState);
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
        if (wctx && trackedState)
          publishError({ bus: wctx.bus, phase: trackedState.phase }, toErrorMessage(err));
        sessionStatus = 'failed';
        result = buildSummary({
          ...summaryBase,
          state: trackedState ?? createInitialState(feature),
        });
      }
    },
  );

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
}
