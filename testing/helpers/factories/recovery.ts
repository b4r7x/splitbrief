import { taskId } from '../../../src/core/schemas/task.js';
import type { RecoveryIssue } from '../../../src/core/schemas/recovery.js';

export function makeRecoveryIssue(overrides: Partial<RecoveryIssue> = {}): RecoveryIssue {
  return {
    id: 'rec_2026_04_28_001',
    reason: 'validation-failed',
    phase: 'validating-task',
    status: 'awaiting-user',
    taskId: taskId('T001'),
    taskTitle: 'Fix login validation',
    files: ['src/auth/session.ts'],
    affectedTaskIds: [taskId('T001')],
    message: 'T001 validation failed after 3 attempts',
    details: ['npm test failed in src/auth/session.test.ts'],
    attempts: 3,
    maxAttempts: 3,
    selectedImplementerProfile: 'local-qwen',
    availableActions: [
      'retry-same-worker',
      'route-bigger-worker',
      'skip-current-task',
      'pause-run',
      'abort-workflow',
    ],
    recommendedAction: 'retry-same-worker',
    createdAt: '2026-04-28T12:00:00.000Z',
    ...overrides,
  };
}
