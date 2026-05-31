import type { Task } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { TaskTokenUsage } from '../../../core/schemas/tokens.js';
import type { WorkflowContext } from '../types.js';
import type { RoutingDecision } from '../context-routing/types.js';
import { reviewTaskIfNeeded } from './task-review.js';

export async function stopWithReview(opts: {
  wctx: WorkflowContext;
  state: WorkflowState;
  setTrackedState: (s: WorkflowState) => void;
  task: Task;
  taskIndex: number;
  filesTouched: string[];
  taskBreakdowns: TaskTokenUsage[];
  routingDecision?: RoutingDecision | undefined;
  implementerProfile?: string | undefined;
}): Promise<WorkflowState> {
  const review = await reviewTaskIfNeeded({
    wctx: opts.wctx,
    state: opts.state,
    setTrackedState: opts.setTrackedState,
    task: opts.task,
    taskIndex: opts.taskIndex,
    filesTouched: opts.filesTouched,
    taskBreakdowns: opts.taskBreakdowns,
    routingDecision: opts.routingDecision,
    implementerProfile: opts.implementerProfile,
  });
  return review.state;
}
