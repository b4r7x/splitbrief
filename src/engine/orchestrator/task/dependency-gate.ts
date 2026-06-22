import type { Task, TaskId } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { TaskTokenUsage } from '../../../core/schemas/tokens.js';
import type { WorkflowContext } from '../types.js';
import { getFailedTaskIds, getSkippedTaskIds } from '../../../core/state/selectors.js';
import { nowIso } from '../../../utils/format-time.js';
import { raisePendingRecovery } from '../state-ops.js';
import { buildDependencyBlockedRecoveryIssue } from '../recovery/builders/task.js';
import { stopWithReview } from './stop-with-review.js';

function hasDependencyFailed(task: Task, failedTasks: TaskId[], skippedTasks: TaskId[]): boolean {
  const blocked = new Set<string>([...failedTasks, ...skippedTasks]);
  return task.dependsOn.some((dep) => blocked.has(dep));
}

export async function checkDependencyGate(opts: {
  wctx: WorkflowContext;
  state: WorkflowState;
  setTrackedState: (s: WorkflowState) => void;
  task: Task;
  taskIndex: number;
  taskBreakdowns: TaskTokenUsage[];
}): Promise<{ state: WorkflowState; stopped: boolean; cancelled: boolean }> {
  const { wctx, task, taskIndex, taskBreakdowns, setTrackedState } = opts;
  let state = opts.state;
  const failedTaskIds = getFailedTaskIds(state);
  const skippedTaskIds = getSkippedTaskIds(state);
  if (!hasDependencyFailed(task, failedTaskIds, skippedTaskIds)) {
    return { state, stopped: false, cancelled: false };
  }
  const blockedByTaskIds = task.dependsOn.filter(
    (id) => failedTaskIds.includes(id) || skippedTaskIds.includes(id),
  );
  const blockedByTasks = state.tasks.filter((candidate) => blockedByTaskIds.includes(candidate.id));
  const issue = buildDependencyBlockedRecoveryIssue({
    task,
    blockedByTaskIds,
    blockedByTasks,
    phase: state.phase,
    createdAt: nowIso(),
  });
  state = raisePendingRecovery(wctx, state, issue, setTrackedState);
  const review = await stopWithReview({
    wctx,
    state,
    setTrackedState,
    task,
    taskIndex,
    filesTouched: issue.files,
    taskBreakdowns,
  });
  return { state: review.state, stopped: true, cancelled: review.cancelled };
}
