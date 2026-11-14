import { describe, expect, it } from 'vitest';
import { makeTask } from '#testing/helpers/factories/task.js';
import { createdAt, expectValidRecoveryIssue } from '#testing/helpers/recovery-issue.js';
import { buildApprovalDeniedRecoveryIssue, buildSnapshotFailedRecoveryIssue } from './approval.js';

describe('buildApprovalDeniedRecoveryIssue', () => {
  it('carries the denied files and the denial reason', () => {
    const issue = buildApprovalDeniedRecoveryIssue({
      task: makeTask({ id: 'T025', suggestedFiles: ['src/main.ts'] }),
      createdAt,
      deniedFiles: ['src/secret.ts'],
      denialReason: 'operator denied',
    });

    expect(issue.reason).toBe('approval-denied');
    expect(issue.files).toEqual(['src/secret.ts']);
    expect(issue.details.join('\n')).toContain('Denied: operator denied');
    expect(issue.availableActions).toEqual(['retry-same-worker', 'skip-current-task', 'end-run']);
    expect(issue.recommendedAction).toBe('retry-same-worker');
    expectValidRecoveryIssue(issue);
  });
});

describe('buildSnapshotFailedRecoveryIssue', () => {
  it('explains that scope cannot be enforced and offers the retry', () => {
    const issue = buildSnapshotFailedRecoveryIssue({
      task: makeTask({ id: 'T026' }),
      createdAt,
      detail: 'git status failed: not a repository',
    });

    expect(issue.reason).toBe('snapshot-failed');
    expect(issue.details).toEqual([
      'git status failed: not a repository',
      'Scope and revert cannot be enforced without the snapshot.',
    ]);
    expect(issue.availableActions).toEqual(['retry-same-worker', 'end-run']);
    expect(issue.recommendedAction).toBe('retry-same-worker');
    expectValidRecoveryIssue(issue);
  });
});
