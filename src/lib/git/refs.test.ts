import { describe, it, expect, afterEach } from 'vitest';
import { chmodSync, unlinkSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { execSync } from 'node:child_process';
import { simpleGit } from 'simple-git';
import {
  GIT_EMPTY_TREE_HASH,
  branchExists,
  createBranch,
  deriveLegacyRunStartHead,
  getCurrentCommitSha,
  resolveRunStartBase,
} from './refs.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';

function setupGitRepo(): string {
  const dir = createTempDir('splitbrief-git-test');
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

describe('deriveLegacyRunStartHead', () => {
  it('returns the newest commit whose subject does not start with the run prefix', async () => {
    const dir = tracked(setupGitRepo());
    const base = execSync('git rev-parse HEAD', { cwd: dir }).toString().trim();
    writeFileSync(join(dir, 'a.txt'), 'a');
    execSync('git add a.txt && git commit -m "feat(splitbrief): T001 - a"', {
      cwd: dir,
      stdio: 'pipe',
    });
    writeFileSync(join(dir, 'b.txt'), 'b');
    execSync('git add b.txt && git commit -m "feat(splitbrief): T002 - b"', {
      cwd: dir,
      stdio: 'pipe',
    });
    expect(await deriveLegacyRunStartHead(dir, 'feat(splitbrief):')).toBe(base);
  });

  it('returns null when every reachable commit carries the run prefix', async () => {
    const dir = tracked(createTempDir('splitbrief-allrun'));
    execSync('git init', { cwd: dir, stdio: 'pipe' });
    execSync('git config user.email "t@t.com" && git config user.name "T"', {
      cwd: dir,
      stdio: 'pipe',
    });
    writeFileSync(join(dir, 'a.txt'), 'a');
    execSync('git add a.txt && git commit -m "feat(splitbrief): T001 - a"', {
      cwd: dir,
      stdio: 'pipe',
    });
    expect(await deriveLegacyRunStartHead(dir, 'feat(splitbrief):')).toBeNull();
  });
});

describe('resolveRunStartBase', () => {
  it('uses a captured SHA even when later commit subjects are misleading', async () => {
    const dir = tracked(setupGitRepo());
    const captured = execSync('git rev-parse HEAD', { cwd: dir }).toString().trim();
    writeFileSync(join(dir, 'run-like.txt'), 'pre-existing user work');
    execSync('git add run-like.txt && git commit -m "feat(splitbrief): misleading subject"', {
      cwd: dir,
      stdio: 'pipe',
    });

    await expect(
      resolveRunStartBase({
        projectDir: dir,
        provenance: { kind: 'captured', head: captured },
      }),
    ).resolves.toEqual({ kind: 'commit', ref: captured });
  });

  it('uses only the working tree for a captured unborn repository without commits', async () => {
    const dir = tracked(createTempDir('splitbrief-unborn-base'));
    execSync('git init', { cwd: dir, stdio: 'pipe' });

    await expect(
      resolveRunStartBase({
        projectDir: dir,
        provenance: { kind: 'captured', head: null },
      }),
    ).resolves.toEqual({ kind: 'working-tree-only' });
  });

  it('uses the empty tree for a captured unborn repository after its first commit', async () => {
    const dir = tracked(createTempDir('splitbrief-born-base'));
    execSync('git init', { cwd: dir, stdio: 'pipe' });
    execSync('git config user.email "t@t.com" && git config user.name "T"', {
      cwd: dir,
      stdio: 'pipe',
    });
    writeFileSync(join(dir, 'first.txt'), 'first');
    execSync('git add first.txt && git commit -m "first"', { cwd: dir, stdio: 'pipe' });

    await expect(
      resolveRunStartBase({
        projectDir: dir,
        provenance: { kind: 'captured', head: null },
      }),
    ).resolves.toEqual({ kind: 'empty-tree', ref: GIT_EMPTY_TREE_HASH });
  });

  it('uses subject discovery only when explicitly given legacy provenance', async () => {
    const dir = tracked(setupGitRepo());
    const base = execSync('git rev-parse HEAD', { cwd: dir }).toString().trim();
    writeFileSync(join(dir, 'run.txt'), 'run');
    execSync('git add run.txt && git commit -m "feat(splitbrief): T001 - run"', {
      cwd: dir,
      stdio: 'pipe',
    });

    await expect(
      resolveRunStartBase({
        projectDir: dir,
        provenance: {
          kind: 'legacy-prefix',
          commitMessagePrefix: 'feat(splitbrief):',
        },
      }),
    ).resolves.toEqual({ kind: 'commit', ref: base });
  });

  it('uses the empty tree when every legacy commit carries the run prefix', async () => {
    const dir = tracked(createTempDir('splitbrief-allrun-base'));
    execSync('git init', { cwd: dir, stdio: 'pipe' });
    execSync('git config user.email "t@t.com" && git config user.name "T"', {
      cwd: dir,
      stdio: 'pipe',
    });
    writeFileSync(join(dir, 'run.txt'), 'run');
    execSync('git add run.txt && git commit -m "feat(splitbrief): T001 - run"', {
      cwd: dir,
      stdio: 'pipe',
    });

    await expect(
      resolveRunStartBase({
        projectDir: dir,
        provenance: {
          kind: 'legacy-prefix',
          commitMessagePrefix: 'feat(splitbrief):',
        },
      }),
    ).resolves.toEqual({ kind: 'empty-tree', ref: GIT_EMPTY_TREE_HASH });
  });

  it('uses only the working tree for legacy provenance in an unborn repository', async () => {
    const dir = tracked(createTempDir('splitbrief-unborn-legacy-base'));
    execSync('git init', { cwd: dir, stdio: 'pipe' });

    await expect(
      resolveRunStartBase({
        projectDir: dir,
        provenance: {
          kind: 'legacy-prefix',
          commitMessagePrefix: 'feat(splitbrief):',
        },
      }),
    ).resolves.toEqual({ kind: 'working-tree-only' });
  });

  it('surfaces an unexpected legacy history failure as a Git boundary error', async () => {
    const dir = tracked(setupGitRepo());
    const head = execSync('git rev-parse HEAD', { cwd: dir }).toString().trim();
    unlinkSync(join(dir, '.git', 'objects', head.slice(0, 2), head.slice(2)));

    await expect(deriveLegacyRunStartHead(dir, 'feat(splitbrief):')).rejects.toMatchObject({
      kind: 'git-command-failed',
      data: { intent: 'log --format=%H%x00%s HEAD' },
    });
  });

  it('surfaces an invalid captured ref as a Git boundary error', async () => {
    const dir = tracked(setupGitRepo());

    await expect(
      resolveRunStartBase({
        projectDir: dir,
        provenance: { kind: 'captured', head: 'not-a-valid-ref' },
      }),
    ).rejects.toMatchObject({ kind: 'git-command-failed' });
  });
});

describe('getCurrentCommitSha', () => {
  it('returns the concrete current commit SHA', async () => {
    const dir = tracked(setupGitRepo());
    const head = execSync('git rev-parse HEAD', { cwd: dir }).toString().trim();

    await expect(getCurrentCommitSha(dir)).resolves.toBe(head);
  });

  it('rejects successful rev-parse output that is empty after trimming', async () => {
    const dir = tracked(createTempDir('splitbrief-empty-git-output'));
    const fakeGit = join(dir, 'git');
    writeFileSync(fakeGit, '#!/bin/sh\nexit 0\n');
    chmodSync(fakeGit, 0o755);
    const originalPath = process.env.PATH;
    process.env.PATH = [dir, originalPath].filter(Boolean).join(delimiter);

    try {
      await expect(getCurrentCommitSha(dir)).rejects.toMatchObject({
        kind: 'git-command-failed',
        data: {
          intent: 'rev-parse HEAD',
          causeMessage: 'rev-parse HEAD returned empty output',
        },
      });
    } finally {
      if (originalPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = originalPath;
      }
    }
  });
});

describe('branchExists', () => {
  it('returns false for a branch that does not exist', async () => {
    const dir = tracked(setupGitRepo());
    expect(await branchExists(dir, 'splitbrief/nonexistent')).toBe(false);
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
    const name = await createBranch(dir, 'splitbrief/add-auth');
    expect(name).toBe('splitbrief/add-auth');
    const g = simpleGit(dir);
    const status = await g.status();
    expect(status.current).toBe('splitbrief/add-auth');
  });

  it('appends -2 on collision', async () => {
    const dir = tracked(setupGitRepo());
    const g = simpleGit(dir);
    const initStatus = await g.status();
    const defaultBranch = initStatus.current ?? 'main';
    await createBranch(dir, 'splitbrief/foo');
    await g.checkout(defaultBranch);
    const name = await createBranch(dir, 'splitbrief/foo');
    expect(name).toBe('splitbrief/foo-2');
  });

  it('increments suffix through multiple collisions', async () => {
    const dir = tracked(setupGitRepo());
    const g = simpleGit(dir);
    const initStatus = await g.status();
    const defaultBranch = initStatus.current ?? 'main';
    await createBranch(dir, 'splitbrief/bar');
    await g.checkout(defaultBranch);
    await g.checkoutLocalBranch('splitbrief/bar-2');
    await g.checkout(defaultBranch);
    const name = await createBranch(dir, 'splitbrief/bar');
    expect(name).toBe('splitbrief/bar-3');
  });
});
