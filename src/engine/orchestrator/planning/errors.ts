import { error } from '../../../utils/error.js';

export const planningError = {
  zeroTasks: (planner: 'instant' | 'quick') =>
    error('planning-zero-tasks', `${planner} planner returned zero tasks; cannot proceed`, {
      planner,
    }),
  briefQualityGateFailed: (code: string, taskId: string) =>
    error('planning-brief-quality-gate', `brief quality gate failed: ${code} in ${taskId}`, {
      code,
      taskId,
    }),
} as const;
