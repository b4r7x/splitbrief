import type { WorkflowState } from '../../../core/schemas/workflow/state.js';
import type { BriefExecution } from '../../../core/schemas/brief-execution.js';
import { classifyTaskCompletionMethod } from '../../../core/task-completion.js';

export type BuildSummaryState = Pick<WorkflowState, 'tasks' | 'taskBreakdowns'>;

export function countLocalAndEscalatedTasks(
  state: BuildSummaryState,
  taskBreakdowns: BriefExecution[] | undefined,
): { local: number; escalated: number } {
  const latestMethodByTask = new Map<string, BriefExecution['method']>();
  for (const breakdown of taskBreakdowns ?? []) {
    latestMethodByTask.set(breakdown.taskId, breakdown.method);
  }

  let local = 0;
  let escalated = 0;
  for (const task of state.tasks) {
    if (task.status !== 'done' && task.status !== 'escalated') continue;
    const method = latestMethodByTask.get(task.id);
    if (method) {
      const completionClass = classifyTaskCompletionMethod(method);
      if (completionClass === 'local') local += 1;
      else if (completionClass === 'escalated') escalated += 1;
      continue;
    }
    if (task.status === 'done') local += 1;
    else escalated += 1;
  }
  return { local, escalated };
}
