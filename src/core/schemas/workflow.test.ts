import { describe, expect, it } from 'vitest';
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

  it('accepts state with pendingRecovery field', () => {
    const result = WorkflowStateSchema.safeParse({
      stateVersion: 3,
      phase: 'implementing',
      feature: 'recover session',
      currentTaskIndex: 0,
      attempt: 0,
      tasks: [],
      plannerSessionId: null,
      startedAt: '2026-04-28T12:00:00.000Z',
      tokenUsage,
      pendingRecovery: {
        id: 'rec_001',
        reason: 'retry-exhausted',
        phase: 'implementing',
        status: 'awaiting-user',
        files: [],
        affectedTaskIds: [],
        message: 'exhausted retries',
        details: [],
        availableActions: ['abort-workflow'],
        recommendedAction: 'abort-workflow',
        createdAt: '2026-04-28T12:00:00.000Z',
      },
    });

    expect(result.success).toBe(true);
  });
});
