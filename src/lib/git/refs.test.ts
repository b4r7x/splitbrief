import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { simpleGit } from 'simple-git';
import { getRunStartHead, branchExists, createBranch } from './refs.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';

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

describe('getRunStartHead', () => {
  it('returns the newest commit whose subject does not start with the run prefix', async () => {
    const dir = tracked(setupGitRepo());
    const base = execSync('git rev-parse HEAD', { cwd: dir }).toString().trim();
    writeFileSync(join(dir, 'a.txt'), 'a');
    execSync('git add a.txt && git commit -m "feat(diptych): T001 - a"', {
      cwd: dir,
      stdio: 'pipe',
    });
    writeFileSync(join(dir, 'b.txt'), 'b');
    execSync('git add b.txt && git commit -m "feat(diptych): T002 - b"', {
      cwd: dir,
      stdio: 'pipe',
    });
    expect(await getRunStartHead(dir, 'feat(diptych):')).toBe(base);
  });

  it('returns null when every reachable commit carries the run prefix', async () => {
    const dir = tracked(createTempDir('diptych-allrun'));
    execSync('git init', { cwd: dir, stdio: 'pipe' });
    execSync('git config user.email "t@t.com" && git config user.name "T"', {
      cwd: dir,
      stdio: 'pipe',
    });
    writeFileSync(join(dir, 'a.txt'), 'a');
    execSync('git add a.txt && git commit -m "feat(diptych): T001 - a"', {
      cwd: dir,
      stdio: 'pipe',
    });
    expect(await getRunStartHead(dir, 'feat(diptych):')).toBeNull();
  });
});

describe('branchExists', () => {
  it('returns false for a branch that does not exist', async () => {
    const dir = tracked(setupGitRepo());
    expect(await branchExists(dir, 'diptych/nonexistent')).toBe(false);
  });

  it('returns true for the current branch', async () => {
    const dir = tracked(setupGitRepo());
    const g = simpleGit(dir);
    const status = await g.status();
    const currentBranch = status.current ?? 'main';
    expect(await branchExists(dir, currentBranch)).toBe(true);
  });
});

describe('createBranch', () => {
  it('creates a new branch and returns its name', async () => {
    const dir = tracked(setupGitRepo());
    const name = await createBranch(dir, 'diptych/add-auth');
    expect(name).toBe('diptych/add-auth');
    const g = simpleGit(dir);
    const status = await g.status();
    expect(status.current).toBe('diptych/add-auth');
  });

  it('appends -2 on collision', async () => {
    const dir = tracked(setupGitRepo());
    const g = simpleGit(dir);
    const initStatus = await g.status();
    const defaultBranch = initStatus.current ?? 'main';
    await createBranch(dir, 'diptych/foo');
    await g.checkout(defaultBranch);
    const name = await createBranch(dir, 'diptych/foo');
    expect(name).toBe('diptych/foo-2');
  });

  it('increments suffix through multiple collisions', async () => {
    const dir = tracked(setupGitRepo());
    const g = simpleGit(dir);
    const initStatus = await g.status();
    const defaultBranch = initStatus.current ?? 'main';
    await createBranch(dir, 'diptych/bar');
    await g.checkout(defaultBranch);
    await g.checkoutLocalBranch('diptych/bar-2');
    await g.checkout(defaultBranch);
    const name = await createBranch(dir, 'diptych/bar');
    expect(name).toBe('diptych/bar-3');
  });
});
