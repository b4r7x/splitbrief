import { describe, expect, it } from 'vitest';
import { allowedActionsForReason, RecoveryIssueSchema } from './recovery.js';
import { makeRecoveryIssue } from '#testing/helpers/factories/recovery.js';

describe('RecoveryIssueSchema', () => {
  it('parses a durable recovery issue with task, actions, and context facts', () => {
    const result = RecoveryIssueSchema.safeParse(
      makeRecoveryIssue({
        facts: {
          spend: 4.36,
          budgetPercent: 87,
          contextLimit: 32_768,
        },
      }),
    );

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.reason).toBe('validation-failed');
    expect(result.data.facts?.contextLimit).toBe(32_768);
  });

  it('rejects a recommended action that is not available', () => {
    const result = RecoveryIssueSchema.safeParse({
      id: 'rec_2026_04_28_002',
      reason: 'budget-exceeded',
      phase: 'implementing',
      status: 'awaiting-user',
      files: [],
      affectedTaskIds: [],
      message: 'Budget exceeded',
      details: ['Spent $5.00 of $5.00'],
      availableActions: ['pause-run', 'abort-workflow'],
      recommendedAction: 'continue',
      createdAt: '2026-04-28T12:00:00.000Z',
    });

    expect(result.success).toBe(false);
  });

  it('rejects available actions that violate the reason policy', () => {
    const result = RecoveryIssueSchema.safeParse({
      id: 'rec_2026_04_28_006',
      reason: 'budget-exceeded',
      phase: 'implementing',
      status: 'awaiting-user',
      files: [],
      affectedTaskIds: [],
      message: 'Budget exceeded',
      details: ['Spent $5.00 of $5.00'],
      availableActions: ['pause-run', 'abort-workflow', 'skip-current-task'],
      recommendedAction: 'pause-run',
      createdAt: '2026-04-28T12:00:00.000Z',
    });

    expect(result.success).toBe(false);
  });

  it('rejects skip-current-task for context overflow', () => {
    const result = RecoveryIssueSchema.safeParse({
      id: 'rec_2026_04_28_007',
      reason: 'context-overflow',
      phase: 'implementing',
      status: 'awaiting-user',
      files: [],
      affectedTaskIds: ['T001'],
      message: 'Context overflow',
      details: ['Worker hit the context limit'],
      availableActions: ['retry-same-worker', 'skip-current-task'],
      recommendedAction: 'retry-same-worker',
      createdAt: '2026-04-28T12:00:00.000Z',
    });

    expect(result.success).toBe(false);
  });

  it('rejects a selected action that is not available', () => {
    const result = RecoveryIssueSchema.safeParse({
      id: 'rec_2026_04_28_005',
      reason: 'budget-exceeded',
      phase: 'implementing',
      status: 'applying',
      files: [],
      affectedTaskIds: [],
      message: 'Budget exceeded',
      details: ['Spent $5.00 of $5.00'],
      availableActions: ['pause-run', 'abort-workflow'],
      recommendedAction: 'pause-run',
      selectedAction: 'continue',
      createdAt: '2026-04-28T12:00:00.000Z',
    });

    expect(result.success).toBe(false);
  });

  it('returns fresh allowed-action arrays for callers', () => {
    const first = allowedActionsForReason('context-overflow');
    first.push('skip-current-task');

    expect(allowedActionsForReason('context-overflow')).not.toContain('skip-current-task');
  });
});
