import { describe, expect, it } from 'vitest';
import { RecoveryIssueSchema } from '../../../../core/schemas/recovery/schemas.js';
import { buildApplyConflictRecoveryIssue, buildApplyPartialRecoveryIssue } from './apply.js';

const createdAt = '2026-04-28T12:00:00.000Z';

describe('buildApplyConflictRecoveryIssue', () => {
  it('offers Re-run Apply or the end and recommends Re-run Apply', () => {
    const issue = buildApplyConflictRecoveryIssue({
      conflicts: [{ path: 'a.txt', kind: 'text' }],
      workspacePath: '/tmp/ws',
      createdAt,
    });

    expect(issue.availableActions).toEqual(['retry-same-worker', 'end-run']);
    expect(issue.recommendedAction).toBe('retry-same-worker');
    expect(RecoveryIssueSchema.safeParse(issue).success).toBe(true);
  });

  it('names the side a file changed on during Apply', () => {
    const issue = buildApplyConflictRecoveryIssue({
      conflicts: [
        { path: 'b.txt', kind: 'workspace-changed' },
        { path: 'a.txt', kind: 'checkout-changed' },
      ],
      workspacePath: '/tmp/ws',
      createdAt,
    });

    expect(issue.files).toEqual(['a.txt', 'b.txt']);
    expect(issue.details.slice(1)).toEqual([
      'a.txt · changed in your checkout during Apply',
      'b.txt · changed in the run workspace during Apply',
    ]);
  });
});

describe('buildApplyPartialRecoveryIssue', () => {
  it('offers Re-run Apply, the backup restore or the end, and recommends Re-run Apply', () => {
    const issue = buildApplyPartialRecoveryIssue({
      backupId: 'b1',
      backupDir: '/tmp/backup',
      createdAt,
      written: ['a.txt'],
      files: ['a.txt', 'b.txt'],
      failedFile: 'b.txt',
      cause: 'EACCES',
    });

    expect(issue.availableActions).toEqual(['retry-same-worker', 'restore-backup', 'end-run']);
    expect(issue.recommendedAction).toBe('retry-same-worker');
    expect(RecoveryIssueSchema.safeParse(issue).success).toBe(true);
  });
});
