import { error } from '../../../utils/error.js';

export const planningError = {
  zeroTasks: () =>
    error('planning-zero-tasks', 'quick planner returned zero tasks; cannot proceed', {
      planner: 'quick',
    }),
  briefQualityGateFailed: (code: string, taskId: string) =>
    error('planning-brief-quality-gate', `brief quality gate failed: ${code} in ${taskId}`, {
      code,
      taskId,
    }),
} as const;
