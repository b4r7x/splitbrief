import { describe, expect, it } from 'vitest';
import { makeTask } from '#testing/helpers/factories/task.js';
import { createdAt, expectValidRecoveryIssue } from '#testing/helpers/recovery-issue.js';
import {
  buildDependencyBlockedRecoveryIssue,
  buildImplementerUnavailableRecoveryIssue,
} from './brief-blocked.js';

describe('buildImplementerUnavailableRecoveryIssue', () => {
  it('offers a retry, skip or end and recommends the retry', () => {
    const issue = buildImplementerUnavailableRecoveryIssue({
      task: makeTask({ id: 'T014' }),
      createdAt,
      tool: 'codex',
      availabilityReason: 'not installed',
    });

    expect(issue.reason).toBe('implementation-error');
    expect(issue.availableActions).toEqual(['retry-same-worker', 'skip-current-task', 'end-run']);
    expect(issue.recommendedAction).toBe('retry-same-worker');
    expectValidRecoveryIssue(issue);
  });
});

describe('buildDependencyBlockedRecoveryIssue', () => {
  it('builds dependency-blocked issues with affected tasks and safe actions', () => {
    const dependency = makeTask({ id: 'T018', suggestedFiles: ['src/base.ts'], status: 'failed' });
    const task = makeTask({
      id: 'T019',
      suggestedFiles: ['src/followup.ts'],
      dependsOn: ['T018'],
    });

    const issue = buildDependencyBlockedRecoveryIssue({
      createdAt,
      task,
      blockedByTasks: [dependency],
    });

    expect(issue.reason).toBe('dependency-blocked');
    expect(issue.files).toEqual(['src/base.ts', 'src/followup.ts']);
    expect(issue.affectedTaskIds).toEqual([dependency.id, task.id]);
    expect(issue.details).toEqual(['Blocked dependencies: T018 (failed)']);
    expect(issue.availableActions).toEqual(['skip-current-task', 'end-run']);
    expect(issue.recommendedAction).toBe('skip-current-task');
    expectValidRecoveryIssue(issue);
  });

  it('names every file of the blocked brief and of its dependency, with their scope paths', () => {
    const dependency = makeTask({
      id: 'T018',
      suggestedFiles: ['lib/clamp.js', 'test.js'],
      status: 'skipped',
    });
    const task = makeTask({
      id: 'T019',
      suggestedFiles: ['lib/range.js', 'test/range.test.js'],
      scope: { inBounds: ['Keep `lib/index.js` in sync.'] },
      dependsOn: ['T018'],
    });

    const issue = buildDependencyBlockedRecoveryIssue({
      createdAt,
      task,
      blockedByTasks: [dependency],
    });

    expect(issue.files).toEqual([
      'lib/clamp.js',
      'lib/index.js',
      'lib/range.js',
      'test.js',
      'test/range.test.js',
    ]);
  });
});
