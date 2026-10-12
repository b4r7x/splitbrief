import type { WorkflowState } from '../schemas/workflow.js';
import type { Task, TaskId } from '../schemas/task.js';
import type { TaskStatus } from '../schemas/enums.js';

function getTaskIdsByStatus(state: Pick<WorkflowState, 'tasks'>, status: TaskStatus): TaskId[] {
  return state.tasks.filter((t) => t.status === status).map((t) => t.id);
}

/** The brief a run that has not completed is inside: the current one, while it is in progress. */
export function briefInFlight(
  state: Pick<WorkflowState, 'phase' | 'tasks' | 'currentTaskIndex'>,
): Task | undefined {
  if (state.phase === 'complete') return undefined;
  const current = state.tasks[state.currentTaskIndex];
  return current?.status === 'in_progress' ? current : undefined;
}

export function getCompletedTaskIds(state: Pick<WorkflowState, 'tasks'>): TaskId[] {
  return getTaskIdsByStatus(state, 'done');
}

export function getFailedTaskIds(state: Pick<WorkflowState, 'tasks'>): TaskId[] {
  return getTaskIdsByStatus(state, 'failed');
}

export function getSkippedTaskIds(state: Pick<WorkflowState, 'tasks'>): TaskId[] {
  return getTaskIdsByStatus(state, 'skipped');
}

export function getEscalatedTaskIds(state: Pick<WorkflowState, 'tasks'>): TaskId[] {
  return getTaskIdsByStatus(state, 'escalated');
}
