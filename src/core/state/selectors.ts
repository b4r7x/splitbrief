import type { WorkflowState } from '../schemas/workflow.js';
import type { TaskId } from '../schemas/task.js';
import type { TaskStatus } from '../schemas/enums.js';

function getTaskIdsByStatus(state: Pick<WorkflowState, 'tasks'>, status: TaskStatus): TaskId[] {
  return state.tasks.filter(t => t.status === status).map(t => t.id);
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
