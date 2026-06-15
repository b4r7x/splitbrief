import { describe, expect, it } from 'vitest';
import { buildRepoChecks, type RepoReadinessInput } from './repo.js';

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
  it('warns that per-task commits are not on any branch on a detached HEAD', () => {
    const checks = buildRepoChecks({ ...cleanRepo, onDetachedHead: true });
    const warning = checks.find((check) => check.id === 'repo.detached-head');

    expect(warning?.severity).toBe('warning');
    expect(warning?.summary).toContain('detached HEAD');
    expect(warning?.details?.[0]).toContain('any branch');
  });

  it('emits no detached-head check when HEAD is on a branch', () => {
    const checks = buildRepoChecks(cleanRepo);
    expect(checks.find((check) => check.id === 'repo.detached-head')).toBeUndefined();
  });
});

describe('buildRepoChecks git identity', () => {
  it('warns when committer identity is missing and a per-task commit strategy is set', () => {
    const checks = buildRepoChecks({
      ...cleanRepo,
      committerIdentityConfigured: false,
      commitStrategy: 'per-task',
    });
    const warning = checks.find((check) => check.id === 'repo.git-identity-missing');

    expect(warning?.severity).toBe('warning');
    expect(warning?.summary).toContain('Git identity not configured');
    expect(warning?.fix).toContain('git config user.email');
    expect(warning?.metadata?.['commitStrategy']).toBe('per-task');
  });

  it('warns when committer identity is missing and a checkpoint strategy is set', () => {
    const checks = buildRepoChecks({
      ...cleanRepo,
      committerIdentityConfigured: false,
      commitStrategy: 'checkpoint',
    });

    expect(checks.find((check) => check.id === 'repo.git-identity-missing')?.severity).toBe(
      'warning',
    );
  });

  it('emits no identity warning when the commit strategy is none', () => {
    const checks = buildRepoChecks({
      ...cleanRepo,
      committerIdentityConfigured: false,
      commitStrategy: 'none',
    });

    expect(checks.find((check) => check.id === 'repo.git-identity-missing')).toBeUndefined();
  });

  it('emits no identity warning when committer identity is configured', () => {
    const checks = buildRepoChecks({
      ...cleanRepo,
      committerIdentityConfigured: true,
      commitStrategy: 'per-task',
    });

    expect(checks.find((check) => check.id === 'repo.git-identity-missing')).toBeUndefined();
  });

  it('emits no identity warning when identity state is unknown', () => {
    const checks = buildRepoChecks({ ...cleanRepo, commitStrategy: 'per-task' });

    expect(checks.find((check) => check.id === 'repo.git-identity-missing')).toBeUndefined();
  });
});

describe('buildRepoChecks dirty worktree', () => {
  it('reports a non-blocking warning when the worktree has local changes', () => {
    const checks = buildRepoChecks({
      ...cleanRepo,
      dirtyFiles: ['src/a.ts'],
      untrackedFiles: ['src/b.ts'],
    });
    const dirty = checks.find((check) => check.id === 'repo.dirty-worktree');

    expect(dirty?.severity).toBe('warning');
    expect(dirty?.nextAction).toBeUndefined();
    expect(dirty?.fix).toContain('Review local edits before starting');
    expect(checks.find((check) => check.id === 'repo.dirty-worktree-blocked')).toBeUndefined();
  });

  it('emits no dirty-worktree check on a clean worktree', () => {
    const checks = buildRepoChecks(cleanRepo);
    expect(checks.find((check) => check.id === 'repo.dirty-worktree')).toBeUndefined();
  });
});
