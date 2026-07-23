import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { isGitRepo, hasCommits, getInProgressGitOp } from './repository.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo, startConflictingMerge } from '#testing/helpers/git.js';

function setupGitRepo(): string {
  const dir = createTempDir('diptych-git-test');
  createTestGitRepo(dir);
  return dir;
}

let dirs: string[] = [];

afterEach(() => {
  for (const d of dirs) {
    cleanupTempDir(d);
  }
  dirs = [];
});

function tracked(dir: string) {
  dirs.push(dir);
  return dir;
}

describe('isGitRepo', () => {
  it('returns true inside a git repo', async () => {
    const dir = tracked(setupGitRepo());
    expect(await isGitRepo(dir)).toBe(true);
  });

  it('returns false outside a git repo', async () => {
    const dir = tracked(createTempDir('diptych-nogit'));
    expect(await isGitRepo(dir)).toBe(false);
  });
});

describe('hasCommits', () => {
  it('returns true for a repo with at least one commit', async () => {
    const dir = tracked(setupGitRepo());
    expect(await hasCommits(dir)).toBe(true);
  });

  it('returns false for a freshly initialized repo with no commits', async () => {
    const dir = tracked(createTempDir('diptych-unborn'));
    execSync('git init', { cwd: dir, stdio: 'pipe' });
    expect(await hasCommits(dir)).toBe(false);
  });
});

describe('getInProgressGitOp', () => {
  it('returns null for a clean repository', async () => {
    const dir = tracked(setupGitRepo());
    expect(await getInProgressGitOp(dir)).toBeNull();
  });

  it('detects a conflicted merge in progress', async () => {
    const dir = tracked(createTempDir('diptych-merge'));
    startConflictingMerge(dir);
    expect(existsSync(join(dir, '.git', 'MERGE_HEAD'))).toBe(true);
    expect(await getInProgressGitOp(dir)).toBe('merge');
  });

  it('detects a rebase in progress', async () => {
    const dir = tracked(setupGitRepo());
    mkdirSync(join(dir, '.git', 'rebase-merge'), { recursive: true });
    expect(await getInProgressGitOp(dir)).toBe('rebase');
  });

  it('detects a cherry-pick in progress', async () => {
    const dir = tracked(setupGitRepo());
    writeFileSync(join(dir, '.git', 'CHERRY_PICK_HEAD'), 'deadbeef\n');
    expect(await getInProgressGitOp(dir)).toBe('cherry-pick');
  });

  it('returns null outside a git repository', async () => {
    const dir = tracked(createTempDir('diptych-nogit-op'));
    expect(await getInProgressGitOp(dir)).toBeNull();
  });
});
