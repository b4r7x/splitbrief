import type { TaskCompletionMethod, TaskStatus } from './schemas/enums.js';
import { assertNever } from '../utils/type-guards.js';

export type TaskCompletionClass = 'local' | 'escalated' | 'failed' | 'skipped';

export function classifyTaskCompletionMethod(method: TaskCompletionMethod): TaskCompletionClass {
  switch (method) {
    case 'local':
      return 'local';
    case 'escalated-intermediate':
    case 'escalated-hint':
    case 'escalated-full':
      return 'escalated';
    case 'failed':
      return 'failed';
    case 'skipped':
      return 'skipped';
    default:
      return assertNever(method);
  }
}

export function taskStatusForCompletionMethod(method: TaskCompletionMethod): TaskStatus {
  const completionClass = classifyTaskCompletionMethod(method);
  switch (completionClass) {
    case 'local':
      return 'done';
    case 'escalated':
      return 'escalated';
    case 'failed':
      return 'failed';
    case 'skipped':
      return 'skipped';
    default:
      return assertNever(completionClass);
  }
}
