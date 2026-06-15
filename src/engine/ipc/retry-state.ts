import type { WorkflowState } from '../../core/schemas/workflow.js';

export function buildDetachedRetryState(state: WorkflowState): WorkflowState {
  // Retry re-runs only failed work: reset failed tasks to pending and point the loop at
  // the earliest non-terminal task. done/escalated/skipped tasks and their per-task
  // cost attribution (taskBreakdowns) are preserved, so the retry does not re-plan or
  // re-implement completed work.
  const tasks = state.tasks.map((task) =>
    task.status === 'failed' ? { ...task, status: 'pending' as const } : task,
  );
  const firstIncomplete = tasks.findIndex(
    (task) => task.status === 'pending' || task.status === 'in_progress',
  );
  return {
    ...state,
    tasks,
    phase: 'implementing',
    currentTaskIndex: firstIncomplete >= 0 ? firstIncomplete : state.currentTaskIndex,
    attempt: 0,
    pendingRecovery: undefined,
  };
}
