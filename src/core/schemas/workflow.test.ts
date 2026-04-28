import { describe, expect, it } from 'vitest';
import { taskId } from './task.js';
import { WorkflowStateSchema } from './workflow.js';

const tokenUsage = {
  plannerInput: 0,
  plannerOutput: 0,
  implementerInput: 0,
  implementerOutput: 0,
  escalationInput: 0,
  escalationOutput: 0,
};

describe('WorkflowStateSchema recovery compatibility', () => {
  it('parses old state without pendingRecovery', () => {
    const result = WorkflowStateSchema.safeParse({
      stateVersion: 3,
      phase: 'implementing',
      feature: 'legacy session',
      currentTaskIndex: 0,
      attempt: 0,
      tasks: [],
      plannerSessionId: null,
      startedAt: '2026-04-28T12:00:00.000Z',
      tokenUsage,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.pendingRecovery).toBeUndefined();
    expect(result.data.awaitingContinue).toBe(false);
    expect(result.data.messageQueue).toEqual([]);
  });

  it('parses new state with pendingRecovery', () => {
    const result = WorkflowStateSchema.safeParse({
      stateVersion: 3,
      phase: 'validating-task',
      feature: 'recover session',
      currentTaskIndex: 0,
      attempt: 3,
      tasks: [],
      plannerSessionId: null,
      startedAt: '2026-04-28T12:00:00.000Z',
      tokenUsage,
      pendingRecovery: {
        id: 'rec_2026_04_28_003',
        reason: 'retry-exhausted',
        phase: 'validating-task',
        status: 'awaiting-user',
        taskId: taskId('T001'),
        taskTitle: 'Fix login validation',
        files: ['src/auth/session.ts'],
        affectedTaskIds: [taskId('T001')],
        message: 'T001 exhausted retries',
        details: ['Validation failed 3 times'],
        attempts: 3,
        maxAttempts: 3,
        availableActions: [
          'route-bigger-worker',
          'planner-split-rebase',
          'skip-current-task',
          'pause-run',
          'abort-workflow',
        ],
        recommendedAction: 'planner-split-rebase',
        createdAt: '2026-04-28T12:00:00.000Z',
      },
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.phase).toBe('validating-task');
    expect(result.data.pendingRecovery?.reason).toBe('retry-exhausted');
    expect(result.data.pendingRecovery?.recommendedAction).toBe('planner-split-rebase');
  });
});
