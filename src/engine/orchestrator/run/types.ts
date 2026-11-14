import type { Task } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow/state.js';
import type { PlanningPhaseResult } from '../planning/types.js';
import type { SummaryBase } from '../summary/build.js';
import type { WorkflowContext } from '../types.js';

export type RunTasksAndReviewOptions = {
  wctx: WorkflowContext;
  state: WorkflowState;
  planning: PlanningPhaseResult;
  summaryBase: SummaryBase;
  setTrackedState: (s: WorkflowState) => void;
  setCurrentTask: (t: Pick<Task, 'suggestedFiles' | 'action'> | undefined) => void;
};
