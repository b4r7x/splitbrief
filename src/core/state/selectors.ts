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

/**
 * The brief a run names as its position, counted from 1. The cursor points one past the last
 * brief once every brief has settled, so the position never names a brief the run does not have.
 * A run with no briefs yet has no position.
 */
export function briefPosition(
  state: Pick<WorkflowState, 'tasks' | 'currentTaskIndex'>,
): { position: number; total: number } | undefined {
  const total = state.tasks.length;
  if (total === 0) return undefined;
  return { position: Math.min(state.currentTaskIndex + 1, total), total };
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
