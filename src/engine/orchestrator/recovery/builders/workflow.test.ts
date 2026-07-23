import { describe, expect, it } from 'vitest';
import { makeTask } from '#testing/helpers/factories/task.js';
import { RecoveryIssueSchema } from '../../../../core/schemas/recovery/schemas.js';
import {
  createApprovalPromotionConflict,
  classifyUserEditConflict,
} from '../../user-edit/conflicts.js';
import {
  buildApprovalPromotionConflictRecoveryIssue,
  buildBudgetExceededRecoveryIssue,
  buildBudgetPausedRecoveryIssue,
  buildUserEditConflictRecoveryIssue,
} from './workflow.js';

const createdAt = '2026-04-28T12:00:00.000Z';

function expectValidRecoveryIssue(issue: unknown): void {
  const result = RecoveryIssueSchema.safeParse(issue);
  expect(result.success).toBe(true);
}

describe('buildUserEditConflictRecoveryIssue', () => {
  it('builds blocking user-edit conflicts without unsafe continue', () => {
    const task = makeTask({ id: 'T014', file: 'src/current.ts' });
    const conflict = classifyUserEditConflict({
      files: ['src/current.ts'],
      currentTask: task,
      allTasks: [task],
      currentTaskIndex: 0,
    });

    const issue = buildUserEditConflictRecoveryIssue({
      conflict,
      currentTask: task,
      createdAt,
    });

    expect(issue.reason).toBe('user-edit-conflict');
    expect(issue.message).toBe('User edits conflict with T014');
    expect(issue.files).toEqual(['src/current.ts']);
    expect(issue.affectedTaskIds).toEqual([task.id]);
    expect(issue.availableActions).toEqual(
      expect.arrayContaining(['skip-current-task', 'pause-run', 'abort-workflow']),
    );
    expect(issue.availableActions).not.toContain('planner-split-rebase');
    expect(issue.recommendedAction).toBe('pause-run');
    expectValidRecoveryIssue(issue);
  });

  it('builds safe user-edit conflicts with continue as the recommendation', () => {
    const task = makeTask({ id: 'T015', file: 'src/current.ts' });
    const conflict = classifyUserEditConflict({
      files: ['README.md'],
      currentTask: task,
      allTasks: [task],
      currentTaskIndex: 0,
    });

    const issue = buildUserEditConflictRecoveryIssue({
      conflict,
      currentTask: task,
      createdAt,
    });

    expect(issue.availableActions).toEqual(
      expect.arrayContaining(['continue', 'pause-run', 'abort-workflow']),
    );
    expect(issue.recommendedAction).toBe('continue');
    expect(issue.facts).toMatchObject({ safeToContinue: true, conflictKind: 'unrelated' });
    expectValidRecoveryIssue(issue);
  });

  it('does not expose continue for malformed unsafe user-edit conflicts', () => {
    const task = makeTask({ id: 'T020', file: 'src/current.ts' });
    const conflict = classifyUserEditConflict({
      files: ['src/current.ts'],
      currentTask: task,
      allTasks: [task],
      currentTaskIndex: 0,
    });

    const issue = buildUserEditConflictRecoveryIssue({
      conflict: {
        ...conflict,
        safeToContinue: false,
        availableActions: ['continue-unrelated', 'pause', 'abort-workflow'],
      },
      currentTask: task,
      createdAt,
    });

    expect(issue.availableActions).toEqual(expect.arrayContaining(['pause-run', 'abort-workflow']));
    expect(issue.availableActions).not.toContain('continue');
    expectValidRecoveryIssue(issue);
  });
});

describe('buildApprovalPromotionConflictRecoveryIssue', () => {
  it('builds approval-promotion conflicts without continue', () => {
    const task = makeTask({ id: 'T016', file: 'src/promote.ts' });
    const conflict = createApprovalPromotionConflict({
      files: ['src/promote.ts'],
      currentTaskId: task.id,
    });

    const issue = buildApprovalPromotionConflictRecoveryIssue({
      conflict,
      currentTask: task,
      createdAt,
    });

    expect(issue.reason).toBe('approval-promotion-conflict');
    expect(issue.message).toBe('Approval promotion blocked for T016');
    expect(issue.availableActions).toEqual(
      expect.arrayContaining(['skip-current-task', 'pause-run', 'abort-workflow']),
    );
    expect(issue.availableActions).not.toContain('planner-split-rebase');
    expect(issue.availableActions).not.toContain('continue');
    expectValidRecoveryIssue(issue);
  });
});

describe('buildBudgetPausedRecoveryIssue', () => {
  it('builds budget-paused issues with continue only below max budget', () => {
    const nextTask = makeTask({ id: 'T017', file: 'src/next.ts' });

    const belowMax = buildBudgetPausedRecoveryIssue({
      createdAt,
      currentCost: 4.25,
      maxBudget: 5,
      threshold: 0.85,
      nextTask,
      blockedStep: 'before T017',
    });

    expect(belowMax.reason).toBe('budget-paused');
    expect(belowMax.availableActions).toEqual(
      expect.arrayContaining(['continue', 'pause-run', 'abort-workflow']),
    );
    expect(belowMax.facts).toMatchObject({ budgetPercent: 85, belowMaxBudget: true });
    expectValidRecoveryIssue(belowMax);

    const atMax = buildBudgetPausedRecoveryIssue({
      createdAt,
      currentCost: 5,
      maxBudget: 5,
      nextTask,
    });

    expect(atMax.availableActions).toEqual(expect.arrayContaining(['pause-run', 'abort-workflow']));
    expect(atMax.availableActions).not.toContain('continue');
    expectValidRecoveryIssue(atMax);
  });
});

describe('buildBudgetExceededRecoveryIssue', () => {
  it('builds budget-exceeded issues without ordinary continue', () => {
    const issue = buildBudgetExceededRecoveryIssue({
      createdAt,
      currentCost: 5.25,
      maxBudget: 5,
      blockedStep: 'before final review',
    });

    expect(issue.reason).toBe('budget-exceeded');
    expect(issue.availableActions).toEqual(expect.arrayContaining(['pause-run', 'abort-workflow']));
    expect(issue.availableActions).not.toContain('continue');
    expect(issue.recommendedAction).toBe('pause-run');
    expect(issue.details).toContain('Continuing requires a separate raise-budget flow.');
    expectValidRecoveryIssue(issue);
  });
});
