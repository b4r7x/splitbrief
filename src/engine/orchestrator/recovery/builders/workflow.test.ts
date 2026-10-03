import { describe, expect, it } from 'vitest';
import { makeTask } from '#testing/helpers/factories/task.js';
import { RecoveryIssueSchema } from '../../../../core/schemas/recovery/schemas.js';
import {
  createApprovalPromotionConflict,
  classifyUserEditConflict,
} from '../../user-edit/conflicts.js';
import {
  buildApprovalPromotionConflictRecoveryIssue,
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
      briefHoldsOutput: () => true,
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
      expect.arrayContaining(['skip-current-task', 'pause-run', 'end-run']),
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
      briefHoldsOutput: () => false,
      allTasks: [task],
      currentTaskIndex: 0,
    });

    const issue = buildUserEditConflictRecoveryIssue({
      conflict,
      currentTask: task,
      createdAt,
    });

    expect(issue.availableActions).toEqual(
      expect.arrayContaining(['continue', 'pause-run', 'end-run']),
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
      briefHoldsOutput: () => true,
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

    expect(issue.availableActions).toEqual(expect.arrayContaining(['pause-run', 'end-run']));
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
      expect.arrayContaining(['skip-current-task', 'pause-run', 'end-run']),
    );
    expect(issue.availableActions).not.toContain('planner-split-rebase');
    expect(issue.availableActions).not.toContain('continue');
    expectValidRecoveryIssue(issue);
  });
});
