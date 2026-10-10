import type { Phase } from '../../../core/schemas/enums.js';
import {
  selectRunningBrief,
  type TasksState,
  type WorkflowTask,
} from '../../../stores/workflow/tasks.js';

export function queuedBriefs(input: {
  tasks: TasksState;
  phase: Phase;
  sidebarShowsTasks: boolean;
  closed: boolean;
}): WorkflowTask[] {
  if (input.sidebarShowsTasks || input.closed) return [];
  // Recovery can reset the running brief to pending before its next start.
  const runningBrief = selectRunningBrief(input.tasks, input.phase).current;
  return input.tasks.tasks.filter((task) => task.status === 'pending' && task !== runningBrief);
}
