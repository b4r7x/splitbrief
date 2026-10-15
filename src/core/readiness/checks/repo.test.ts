import { describe, expect, it } from 'vitest';
import { buildRepoChecks, exemptLiveSessionBlocker, type RepoReadinessInput } from './repo.js';

const cleanRepo: RepoReadinessInput = {
  isGitRepo: true,
  hasCommits: true,
  dirtyFiles: [],
  untrackedFiles: [],
};

describe('buildRepoChecks in-progress git operation', () => {
  it('suggests `git bisect reset` to abort an in-progress bisect', () => {
    const checks = buildRepoChecks({ ...cleanRepo, inProgressGitOp: 'bisect' });
    const blocker = checks.find((check) => check.id === 'repo.in-progress-git-op');

    expect(blocker?.severity).toBe('blocker');
    expect(blocker?.fix).toContain('git bisect reset');
    expect(blocker?.fix).not.toContain('git bisect --abort');
  });

  it('suggests `git <op> --abort` for merge, rebase, cherry-pick, and revert', () => {
    for (const op of ['merge', 'rebase', 'cherry-pick', 'revert'] as const) {
      const checks = buildRepoChecks({ ...cleanRepo, inProgressGitOp: op });
      const blocker = checks.find((check) => check.id === 'repo.in-progress-git-op');

      expect(blocker?.fix).toContain(`git ${op} --abort`);
    }
  });
});

describe('buildRepoChecks detached HEAD', () => {
  it('warns that a commit made on a detached HEAD belongs to no branch', () => {
    const checks = buildRepoChecks({ ...cleanRepo, onDetachedHead: true });
    const warning = checks.find((check) => check.id === 'repo.detached-head');

    expect(warning?.severity).toBe('warning');
    expect(warning?.summary).toContain('detached HEAD');
    expect(warning?.details).toEqual([
      'The run leaves its changes uncommitted in your working tree; a commit you make on a detached HEAD belongs to no branch and is easy to lose.',
    ]);
    expect(warning?.fix).toContain('before you commit the changes');
  });

  it('emits no detached-head check when HEAD is on a branch', () => {
    const checks = buildRepoChecks(cleanRepo);
    expect(checks.find((check) => check.id === 'repo.detached-head')).toBeUndefined();
  });
});

describe('buildRepoChecks dirty worktree', () => {
  it.each(['tracked', 'untracked'] as const)(
    'names the revert backup folder for %s checkout edits',
    (kind) => {
      const checks = buildRepoChecks(
        {
          ...cleanRepo,
          dirtyFiles: kind === 'tracked' ? ['src/a.ts'] : [],
          untrackedFiles: kind === 'untracked' ? ['scratch.txt'] : [],
        },
        'none',
      );
      const warning = checks.find((check) => check.id === 'repo.dirty-worktree');

      expect(warning?.severity).toBe('warning');
      expect(warning?.fix).toContain('The run edits this checkout.');
      expect(warning?.fix).toContain('.splitbrief/sessions/<id>/reverted/');
      expect(warning?.details?.join(' ')).toContain('only the paths that attempt changed');
      expect(warning?.details?.join(' ')).not.toContain('The run edits this checkout');
      expect(checks.some((check) => check.severity === 'blocker')).toBe(false);
    },
  );

  it.each([undefined, 'worktree', 'staged-copy'] as const)(
    'leaves the revert note out of local edits with isolation %s',
    (isolation) => {
      const warning = buildRepoChecks({ ...cleanRepo, dirtyFiles: ['src/a.ts'] }, isolation).find(
        (check) => check.id === 'repo.dirty-worktree',
      );
      expect(warning?.fix).not.toContain('reverted/');
      expect(warning?.details).toEqual(['Examples: src/a.ts']);
    },
  );

  it('reports a non-blocking warning when the worktree has local changes', () => {
    const checks = buildRepoChecks({
      ...cleanRepo,
      dirtyFiles: ['src/a.ts'],
      untrackedFiles: ['src/b.ts'],
    });
    const dirty = checks.find((check) => check.id === 'repo.dirty-worktree');

    expect(dirty?.severity).toBe('warning');
    expect(dirty?.nextAction).toBeUndefined();
    expect(dirty?.fix).toBe('Review local edits if they may overlap the requested change.');
    expect(checks.some((check) => check.severity === 'blocker')).toBe(false);
  });

  it('emits no dirty-worktree check on a clean worktree', () => {
    const checks = buildRepoChecks(cleanRepo);
    expect(checks.find((check) => check.id === 'repo.dirty-worktree')).toBeUndefined();
  });
});

describe('exemptLiveSessionBlocker', () => {
  const liveSessionCheck = (): ReturnType<typeof buildRepoChecks>[number] => {
    const check = buildRepoChecks({
      ...cleanRepo,
      activeSession: 'session-abc',
      activeSessionLive: true,
    }).find((candidate) => candidate.id === 'repo.active-session-live');
    if (check === undefined) throw new Error('expected a live-session blocker');
    return check;
  };

  it('downgrades the live-session blocker to information a read-only purpose can pass', () => {
    const exempted = exemptLiveSessionBlocker(liveSessionCheck());

    expect(exempted.severity).toBe('info');
    expect(exempted.summary).toContain('session-abc');
    expect(exempted.fix).toBeUndefined();
    expect(exempted.nextAction).toBeUndefined();
    expect(exempted.metadata).toEqual({ sessionId: 'session-abc', live: true });
  });

  it('leaves every other check exactly as it was', () => {
    for (const check of buildRepoChecks({ ...cleanRepo, dirtyFiles: ['src/a.ts'] })) {
      expect(exemptLiveSessionBlocker(check)).toBe(check);
    }
  });
});
