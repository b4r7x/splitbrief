import { describe, expect, it } from 'vitest';
import type { RecoveryIssue } from '../../core/schemas/recovery.js';
import { taskId } from '../../core/schemas/task.js';
import { formatRecoveryPrompt, parseRecoveryActionAnswer } from './recovery-prompt.js';

const baseIssue: RecoveryIssue = {
  id: 'rec_test',
  reason: 'validation-failed',
  phase: 'validating-task',
  status: 'awaiting-user',
  taskId: taskId('T003'),
  taskTitle: 'Patch auth validation',
  files: ['src/auth/session.ts', 'src/auth/session.test.ts'],
  affectedTaskIds: [taskId('T003')],
  message: 'T003 validation failed',
  details: [
    'Validation test failed: npm test -- auth failed in src/auth/session.test.ts',
    'Attempts: 3/3',
    'Worker profile: local-qwen',
    'Bigger worker available: cheap-cloud',
  ],
  attempts: 3,
  maxAttempts: 3,
  selectedImplementerProfile: 'local-qwen',
  facts: {
    validationStage: 'test',
    validationSummary: 'npm test -- auth failed',
    routeBiggerProfile: 'cheap-cloud',
  },
  availableActions: [
    'retry-same-worker',
    'route-bigger-worker',
    'planner-split-rebase',
    'skip-current-task',
    'pause-run',
    'abort-workflow',
  ],
  recommendedAction: 'route-bigger-worker',
  createdAt: '2026-04-29T12:00:00.000Z',
};

describe('recovery prompt', () => {
  it('formats a compact validation recovery prompt with only available actions', () => {
    const prompt = formatRecoveryPrompt(baseIssue);

    expect(prompt).toContain('Recovery needed: T003 validation failed after 3 attempts');
    expect(prompt).toContain('Task: T003 - Patch auth validation');
    expect(prompt).toContain('Files: src/auth/session.ts, src/auth/session.test.ts');
    expect(prompt).toContain('Last check: test failed: npm test -- auth failed in src/auth/session.test.ts');
    expect(prompt).toContain('Recommended: route to bigger worker: cheap-cloud');
    expect(prompt).toContain('[r] retry same worker');
    expect(prompt).toContain('[b] route to bigger worker: cheap-cloud');
    expect(prompt).toContain('[p] ask planner to split/rebase (approve/edit/reject proposal)');
    expect(prompt).toContain('[s] skip task');
    expect(prompt).toContain('[space] pause');
    expect(prompt).toContain('[a] abort');
    expect(prompt).not.toContain('[c] continue');
  });

  it('parses answers into typed recovery actions and falls back to pause safely', () => {
    expect(parseRecoveryActionAnswer('r', baseIssue)).toBe('retry-same-worker');
    expect(parseRecoveryActionAnswer('route bigger', baseIssue)).toBe('route-bigger-worker');
    expect(parseRecoveryActionAnswer('p', baseIssue)).toBe('planner-split-rebase');
    expect(parseRecoveryActionAnswer('skip', baseIssue)).toBe('skip-current-task');
    expect(parseRecoveryActionAnswer(' ', baseIssue)).toBe('pause-run');
    expect(parseRecoveryActionAnswer('abort', baseIssue)).toBe('abort-workflow');
    expect(parseRecoveryActionAnswer('continue', baseIssue)).toBe('pause-run');
  });

  it('parses continue only when the issue allows it', () => {
    const issue: RecoveryIssue = {
      id: 'rec_budget_pause',
      reason: 'budget-paused',
      phase: 'implementing',
      status: 'awaiting-user',
      message: 'Budget pause at 87%',
      files: [],
      affectedTaskIds: [],
      details: ['Spent $4.36 of $5.00'],
      facts: { currentCost: 4.36, maxBudget: 5, belowMaxBudget: true },
      availableActions: ['continue', 'pause-run', 'abort-workflow'],
      recommendedAction: 'continue',
      createdAt: '2026-04-29T12:00:00.000Z',
    };

    expect(parseRecoveryActionAnswer('c', issue)).toBe('continue');
  });

  it('hides ordinary continue for budget exceeded even if malformed state advertises it', () => {
    const issue: RecoveryIssue = {
      id: 'rec_budget',
      reason: 'budget-exceeded',
      phase: 'implementing',
      status: 'awaiting-user',
      message: 'Budget exceeded at 105%',
      files: [],
      affectedTaskIds: [],
      details: [
        'Spent $5.25 of $5.00',
        'Blocked step: before T004',
        'Continuing requires a separate raise-budget flow.',
      ],
      facts: { currentCost: 5.25, maxBudget: 5 },
      availableActions: ['continue', 'pause-run', 'abort-workflow'],
      recommendedAction: 'continue',
      createdAt: '2026-04-29T12:00:00.000Z',
    };

    const prompt = formatRecoveryPrompt(issue);

    expect(prompt).toContain('Recovery needed: Budget exceeded at 105%');
    expect(prompt).toContain('Spent: $5.25 of $5.00');
    expect(prompt).toContain('Recommended: pause');
    expect(prompt).toContain('[space] pause');
    expect(prompt).toContain('[a] abort');
    expect(prompt).not.toContain('[c] continue');
    expect(parseRecoveryActionAnswer('c', issue)).toBe('pause-run');
  });

  it('labels user-edit planner rebase as proposal-gated', () => {
    const issue: RecoveryIssue = {
      id: 'rec_user_edit',
      reason: 'user-edit-conflict',
      phase: 'implementing',
      status: 'awaiting-user',
      message: 'User edits conflict with T004',
      taskId: taskId('T004'),
      taskTitle: 'Update session store',
      files: ['src/auth/session.ts'],
      affectedTaskIds: [taskId('T004'), taskId('T006')],
      details: [
        'Conflict kind: current-task-conflict',
        'Safe to continue: no',
      ],
      facts: { conflictKind: 'current-task-conflict', safeToContinue: false },
      availableActions: ['planner-split-rebase', 'skip-current-task', 'pause-run', 'abort-workflow'],
      recommendedAction: 'planner-split-rebase',
      createdAt: '2026-04-29T12:00:00.000Z',
    };

    expect(formatRecoveryPrompt(issue)).toContain(
      '[p] ask planner to rebase on your edits (approve/edit/reject proposal)',
    );
  });
});
