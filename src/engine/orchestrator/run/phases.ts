import type { Task } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { Summary } from '../../../core/schemas/summary.js';
import type { CostPrediction } from '../../../core/schemas/summary.js';
import type { WorkflowContext } from '../types.js';
import type { SkillMeta } from '../../skills/discovery.js';
import type { EventBus } from '../../events/types.js';

import { buildSummary, type SummaryBase } from '../summary.js';
import { publishCostPrediction } from '../events.js';
import { predictCost } from '../cost-prediction.js';
import { runPlanningPhase } from '../planning/run.js';
import { runTaskLoop } from '../task-loop.js';
import { runFinalReviewPhase } from '../final-review.js';
import { drainQueue } from '../queue.js';

export function applyPostPlanDrain(
  projectDir: string,
  sessionId: string,
  state: WorkflowState,
  bus: EventBus,
  setTrackedState: (s: WorkflowState) => void,
): WorkflowState {
  const drain = drainQueue(projectDir, sessionId, state, bus);
  if (drain.messages.length === 0) return state;
  setTrackedState(drain.state);
  return drain.state;
}

export type RunPlanningPhasesOptions = {
  wctx: WorkflowContext;
  state: WorkflowState;
  savedState: WorkflowState | undefined;
  selectedSkills: SkillMeta[] | undefined;
  phaseTimings: Record<string, number>;
  startTime: number;
  setTrackedState: (s: WorkflowState) => void;
};

export async function runPlanningPhases(opts: RunPlanningPhasesOptions): Promise<{ state: WorkflowState; cancelled: boolean }> {
  const { wctx, savedState, selectedSkills, phaseTimings, startTime, setTrackedState } = opts;
  let { state } = opts;
  const { projectDir, sessionId, config, callbacks, planner } = wctx;

  if (!savedState || savedState.rewindPending) {
    const planning = await runPlanningPhase({
      wctx: { projectDir, sessionId, config, callbacks, bus: wctx.bus, signal: wctx.signal, metadata: wctx.metadata, sinks: wctx.sinks },
      planner,
      state,
      feature: state.feature,
      selectedSkills,
      rewindPending: savedState?.rewindPending,
    });
    state = planning.state;
    setTrackedState(state);
    phaseTimings.planning = Date.now() - startTime;
    if (planning.cancelled) return { state, cancelled: true };
  }

  return { state, cancelled: false };
}

export type RunTasksAndReviewOptions = {
  wctx: WorkflowContext;
  state: WorkflowState;
  summaryBase: SummaryBase;
  phaseTimings: Record<string, number>;
  setTrackedState: (s: WorkflowState) => void;
  setCurrentTask: (t: Pick<Task, 'file' | 'action'> | undefined) => void;
};

export async function runTasksAndReview(opts: RunTasksAndReviewOptions): Promise<Summary> {
  const { wctx, phaseTimings, setTrackedState, setCurrentTask } = opts;
  let { summaryBase } = opts;
  let { state } = opts;
  const { callbacks } = wctx;

  if (state.tasks.length > 0) {
    const prediction: CostPrediction = predictCost({
      taskCount: state.tasks.length,
      plannerTool: state.plannerTool ?? '',
      implementerTool: state.implementerTool ?? '',
      tokenUsage: state.tokenUsage,
    });
    publishCostPrediction(wctx.bus, state.phase, prediction);
    summaryBase = { ...summaryBase, costPrediction: prediction };
  }

  const phaseStart = Date.now();
  const taskResult = await runTaskLoop({
    wctx,
    initialState: state,
    setTrackedState,
    setCurrentTask,
  });
  state = taskResult.state;

  phaseTimings.implementing = Date.now() - phaseStart;

  if (wctx.signal?.aborted) {
    return buildSummary({ ...summaryBase, state, taskBreakdowns: taskResult.taskBreakdowns, phaseTimings });
  }

  return runFinalReviewPhase(
    { projectDir: wctx.projectDir, sessionId: wctx.sessionId, config: wctx.config, callbacks, bus: wctx.bus, state, planner: wctx.planner, metadata: wctx.metadata },
    summaryBase,
    taskResult.taskBreakdowns,
    phaseTimings,
  );
}
