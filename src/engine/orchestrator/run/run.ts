import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { Task } from '../../../core/schemas/task.js';
import type { Summary } from '../../../core/schemas/summary.js';
import type { Session } from '../../../core/schemas/session.js';
import type { SpecMetadata } from '../../../core/paths-io.js';
import { DEFAULT_WORKFLOW_MODE } from '../../../core/schemas/config.js';
import { getRunnerDisplayName, getRunnerModelName } from '../../../core/config/accessors/runner-config.js';
import { createInitialState } from '../../../core/state/machine.js';
import { saveState } from '../../../core/state/persistence.js';
import { generateSessionId } from '../../../core/sessions/lifecycle.js';
import { resolveAutoModel } from '../../../core/providers/model-selection.js';
import { killAllProcesses } from '../../../lib/process/registry.js';
import { toErrorMessage, labelError } from '../../../utils/format-errors.js';
import { error } from '../../../utils/error.js';

import type { ResumeContextHolder, WorkflowContext } from '../types.js';
import { buildSummary, type SummaryBase } from '../summary.js';
import { publishError, publishWarning } from '../events.js';
import { saveFinalSession, withShutdownHandlers, installQueueHandler } from '../session-lifecycle.js';

import { initializeWorkflow, type RunWorkflowOptions } from './init.js';
import { runPlanningPhases, runTasksAndReview, applyPostPlanDrain } from './phases.js';

export type { RunWorkflowOptions } from './init.js';

export async function runWorkflow(opts: RunWorkflowOptions): Promise<Summary> {
  const { feature, projectDir, config, savedState, selectedSkills } = opts;
  const startTime = Date.now();
  const plannerModel = getRunnerModelName(config.planner);
  const implementerModel = resolveAutoModel(config.implementer.model, getRunnerDisplayName(config.implementer));
  const sessionId = opts.sessionId ?? generateSessionId(projectDir, feature);
  const summaryBase: SummaryBase = {
    feature, startTime,
    plannerTool: getRunnerDisplayName(config.planner),
    ...(plannerModel !== undefined && { plannerModel }),
    implementerTool: getRunnerDisplayName(config.implementer),
    ...(implementerModel !== undefined && { implementerModel }),
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

  let trackedState: WorkflowState | undefined;
  let currentTask: Pick<Task, 'file' | 'action'> | undefined;
  let result: Summary | undefined;
  let sessionStatus: Session['status'] = 'interrupted';
  let wctx: WorkflowContext | undefined;

  const { cancelled } = await withShutdownHandlers(
    {
      projectDir, sessionId,
      getTrackedState: () => trackedState,
      getCurrentTask: () => currentTask,
    },
    async () => {
      try {
        const resumeHolder: ResumeContextHolder = { messages: [] };
        const init = await initializeWorkflow(opts, sessionId, summaryBase, metadata, (s) => { trackedState = s; }, resumeHolder);
        if (!init.ok) { result = init.summary; return; }

        wctx = init.wctx;
        trackedState = init.state;
        const phaseTimings: Record<string, number> = {};

        installQueueHandler({
          projectDir, sessionId,
          sinks: wctx.sinks,
          getTrackedState: () => trackedState,
          setTrackedState: (s) => { trackedState = s; },
          bus: wctx.bus,
          config,
          planner: wctx.planner,
        });

        const planning = await runPlanningPhases({
          wctx, state: init.state, savedState, selectedSkills, phaseTimings, startTime,
          setTrackedState: (s) => { trackedState = s; },
        });
        if (planning.cancelled) { result = buildSummary({ ...summaryBase, state: planning.state, phaseTimings }); return; }

        if (opts.signal?.aborted) { result = buildSummary({ ...summaryBase, state: planning.state, phaseTimings }); return; }

        const postPlanState = applyPostPlanDrain(projectDir, sessionId, planning.state, wctx.bus, (s) => { trackedState = s; });

        const taskRun = await runTasksAndReview({
          wctx, state: postPlanState, summaryBase, phaseTimings,
          setTrackedState: (s) => { trackedState = s; },
          setCurrentTask: (t) => { currentTask = t; },
        });
        result = taskRun.summary;
        sessionStatus = taskRun.completed ? 'complete' : 'interrupted';
      } catch (err) {
        if (trackedState) {
          try { saveState(projectDir, sessionId, trackedState); } catch (saveErr) {
            if (wctx) publishWarning(wctx.bus, trackedState.phase, labelError('Failed to save state', saveErr));
          }
        }
        killAllProcesses();
        if (wctx && trackedState) publishError(wctx.bus, trackedState.phase, toErrorMessage(err));
        sessionStatus = 'failed';
        result = buildSummary({ ...summaryBase, state: trackedState ?? createInitialState(feature) });
      }
    },
  );

  if (!result) {
    if (cancelled) {
      const summary = buildSummary({ ...summaryBase, state: trackedState ?? createInitialState(feature) });
      saveFinalSession({ projectDir, sessionId, feature, startTime, status: sessionStatus, summary });
      return summary;
    }
    throw error('workflow-no-summary', 'Unreachable: workflow did not produce a summary');
  }
  saveFinalSession({ projectDir, sessionId, feature, startTime, status: sessionStatus, summary: result });
  return result;
}
