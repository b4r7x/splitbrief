import type { Phase } from '../../../core/schemas/enums.js';
import {
  selectRunningBrief,
  type RunBriefs,
  type WorkflowTask,
} from '../../../core/run-view/briefs.js';

export function queuedBriefs(input: {
  tasks: RunBriefs;
  phase: Phase;
  sidebarShowsTasks: boolean;
  closed: boolean;
}): WorkflowTask[] {
  if (input.sidebarShowsTasks || input.closed) return [];
  // Recovery can reset the running brief to pending before its next start.
  const runningBrief = selectRunningBrief(input.tasks, input.phase).current;
  return input.tasks.tasks.filter((task) => task.status === 'pending' && task !== runningBrief);
}
