import type { WorkflowState, Task } from '../../../core/types/state-actions.js';
import type { Summary } from '../../../core/types/summary.js';
import type { Session } from '../../../core/schemas/session.js';
import type { SpecMetadata } from '../../../core/paths-io.js';
import { DEFAULT_WORKFLOW_MODE } from '../../../core/types/config-options.js';
import { getRunnerDisplayName, getRunnerModelName } from '../../../core/config/accessors/runner-config.js';
import { createInitialState } from '../../../core/state/machine.js';
import { saveState } from '../../../core/state/persistence.js';
import { generateSessionId } from '../../../core/sessions/lifecycle.js';
import { resolveAutoModel } from '../../../core/providers/model-selection.js';
import { killAllProcesses } from '../../../lib/process/registry.js';
import { toErrorMessage, labelError } from '../../../utils/format-errors.js';

import type { ResumeContextHolder } from '../types.js';
import { buildSummary, type SummaryBase } from '../summary.js';
import { emitError, emitWarning } from '../events.js';
import { saveFinalSession, withShutdownHandlers, installQueueHandler } from '../session-lifecycle.js';

import { initializeWorkflow, type RunWorkflowOptions } from './init.js';
import { runPlanningPhases, runTasksAndReview, applyPostPlanDrain } from './phases.js';

export type { RunWorkflowOptions } from './init.js';

export async function runWorkflow(opts: RunWorkflowOptions): Promise<Summary> {
  const { feature, projectDir, config, callbacks, savedState, selectedSkills } = opts;
  const startTime = Date.now();
  const plannerModel = getRunnerModelName(config.planner);
  const implementerModel = resolveAutoModel(config.implementer.model, getRunnerDisplayName(config.implementer));
  const summaryBase: SummaryBase = {
    feature, startTime,
    plannerTool: getRunnerDisplayName(config.planner),
    ...(plannerModel !== undefined && { plannerModel }),
    implementerTool: getRunnerDisplayName(config.implementer),
    ...(implementerModel !== undefined && { implementerModel }),
  };

  const metadata: SpecMetadata = {
    plannerTool: summaryBase.plannerTool,
    plannerModel: summaryBase.plannerModel,
    implementerTool: summaryBase.implementerTool,
    implementerModel: summaryBase.implementerModel,
    mode: config.workflow.mode ?? DEFAULT_WORKFLOW_MODE,
  };

  const sessionId = opts.sessionId ?? generateSessionId(projectDir, feature);

  let trackedState: WorkflowState | undefined;
  let currentTask: Pick<Task, 'file' | 'action'> | undefined;
  let result: Summary | undefined;
  let sessionStatus: Session['status'] = 'interrupted';

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

        const { wctx } = init;
        trackedState = init.state;
        const phaseTimings: Record<string, number> = {};

        installQueueHandler({
          projectDir, sessionId,
          sinks: wctx.sinks,
          getTrackedState: () => trackedState,
          setTrackedState: (s) => { trackedState = s; },
          callbacks,
          config,
          planner: wctx.planner,
        });

        const planning = await runPlanningPhases({
          wctx, state: init.state, savedState, selectedSkills, phaseTimings, startTime,
          setTrackedState: (s) => { trackedState = s; },
        });
        if (planning.cancelled) { result = buildSummary({ ...summaryBase, state: planning.state, phaseTimings }); return; }

        if (opts.signal?.aborted) { result = buildSummary({ ...summaryBase, state: planning.state, phaseTimings }); return; }

        const postPlanState = applyPostPlanDrain(projectDir, sessionId, planning.state, callbacks, (s) => { trackedState = s; });

        result = await runTasksAndReview({
          wctx, state: postPlanState, summaryBase, phaseTimings,
          setTrackedState: (s) => { trackedState = s; },
          setCurrentTask: (t) => { currentTask = t; },
        });
        sessionStatus = 'complete';
      } catch (err) {
        if (trackedState) {
          try { saveState(projectDir, sessionId, trackedState); } catch (saveErr) {
            emitWarning(callbacks, labelError('Failed to save state', saveErr));
          }
        }
        killAllProcesses();
        emitError(callbacks, toErrorMessage(err));
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
    throw new Error('Unreachable: workflow did not produce a summary');
  }
  saveFinalSession({ projectDir, sessionId, feature, startTime, status: sessionStatus, summary: result });
  return result;
}
