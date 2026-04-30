import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import {
  isGitRepo,
  commitChanges,
  getCurrentDiff,
  hasExternalChanges,
  getChangedFiles,
  stageAll,
  createTaggedStash,
  discardFileChange,
  branchExists,
  createBranch,
  gitError,
} from './git.js';
import { simpleGit } from 'simple-git';
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

describe('git utils', () => {
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

  describe('stageAll', () => {
    it('stages new untracked files', async () => {
      const dir = tracked(setupGitRepo());
      writeFileSync(join(dir, 'new.txt'), 'hello');
      await stageAll(dir);
      const status = execSync('git status --porcelain', { cwd: dir, encoding: 'utf-8' });
      expect(status).toMatch(/^A\s+new\.txt/m);
    });
  });

  describe('commitChanges', () => {
    it('commits previously staged changes and returns a hash', async () => {
      const dir = tracked(setupGitRepo());
      writeFileSync(join(dir, 'new.txt'), 'hello');
      await stageAll(dir);
      const hash = await commitChanges(dir, 'add new file');
      expect(hash).toBeTruthy();
      expect(typeof hash).toBe('string');
      const log = execSync('git log --oneline', { cwd: dir, encoding: 'utf-8' });
      expect(log).toContain('add new file');
    });

    it('does not auto-stage: unstaged changes are not committed', async () => {
      const dir = tracked(setupGitRepo());
      const headBefore = execSync('git rev-parse HEAD', { cwd: dir, encoding: 'utf-8' }).trim();
      writeFileSync(join(dir, 'new.txt'), 'hello');
      await commitChanges(dir, 'should not include new.txt');
      const headAfter = execSync('git rev-parse HEAD', { cwd: dir, encoding: 'utf-8' }).trim();
      expect(headAfter).toBe(headBefore);
      const log = execSync('git log --oneline', { cwd: dir, encoding: 'utf-8' });
      expect(log).not.toContain('should not include new.txt');
    });
  });

  describe('getCurrentDiff', () => {
    it('returns combined staged and unstaged diff', async () => {
      const dir = tracked(setupGitRepo());
      writeFileSync(join(dir, 'init.txt'), 'changed');
      const diff = await getCurrentDiff(dir);
      expect(diff).toContain('changed');
    });

    it('returns empty string when no changes', async () => {
      const dir = tracked(setupGitRepo());
      const diff = await getCurrentDiff(dir);
      expect(diff).toBe('');
    });
  });

  describe('hasExternalChanges', () => {
    it('returns true when modified files exist', async () => {
      const dir = tracked(setupGitRepo());
      writeFileSync(join(dir, 'init.txt'), 'modified');
      expect(await hasExternalChanges(dir)).toBe(true);
    });

    it('returns false when working tree is clean', async () => {
      const dir = tracked(setupGitRepo());
      expect(await hasExternalChanges(dir)).toBe(false);
    });

    it('returns true for staged created files', async () => {
      const dir = tracked(setupGitRepo());
      writeFileSync(join(dir, 'created.txt'), 'created');
      execSync('git add created.txt', { cwd: dir, stdio: 'ignore' });
      expect(await hasExternalChanges(dir)).toBe(true);
    });

    it('returns true for deleted files', async () => {
      const dir = tracked(setupGitRepo());
      rmSync(join(dir, 'init.txt'));
      expect(await hasExternalChanges(dir)).toBe(true);
    });

    it('returns true for renamed files', async () => {
      const dir = tracked(setupGitRepo());
      execSync('git mv init.txt renamed.txt', { cwd: dir, stdio: 'ignore' });
      expect(await hasExternalChanges(dir)).toBe(true);
    });
  });

  describe('getChangedFiles', () => {
    it('returns modified file paths', async () => {
      const dir = tracked(setupGitRepo());
      writeFileSync(join(dir, 'init.txt'), 'modified');
      const files = await getChangedFiles(dir);
      expect(files).toContain('init.txt');
    });

    it('returns empty array for clean working tree', async () => {
      const dir = tracked(setupGitRepo());
      const files = await getChangedFiles(dir);
      expect(files).toEqual([]);
    });

    it('includes new untracked files', async () => {
      const dir = tracked(setupGitRepo());
      writeFileSync(join(dir, 'new-file.txt'), 'content');
      const files = await getChangedFiles(dir);
      expect(files).toContain('new-file.txt');
    });
  });

  describe('createTaggedStash', () => {
    it('creates a tagged stash sha for dirty working tree and returns its tag', async () => {
      const dir = tracked(setupGitRepo());
      writeFileSync(join(dir, 'init.txt'), 'modified');
      const tag = await createTaggedStash(dir, 'checkpoint: T001', 'checkpoint/T001');
      expect(tag).toBe('checkpoint/T001');
      const tags = execSync('git tag', { cwd: dir, encoding: 'utf-8' });
      expect(tags).toContain('checkpoint/T001');
    });

    it('returns empty string when there is nothing to stash', async () => {
      const dir = tracked(setupGitRepo());
      const tag = await createTaggedStash(dir, 'checkpoint: T002', 'checkpoint/T002');
      expect(tag).toBe('');
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

  describe('discardFileChange', () => {
    it('checks out a tracked file', async () => {
      const dir = tracked(setupGitRepo());
      writeFileSync(join(dir, 'init.txt'), 'modified');
      await discardFileChange(dir, 'init.txt', 'tracked');
      const content = readFileSync(join(dir, 'init.txt'), 'utf-8');
      expect(content).toBe('init');
    });

    it('cleans an untracked file', async () => {
      const dir = tracked(setupGitRepo());
      writeFileSync(join(dir, 'created.txt'), 'new file');
      await discardFileChange(dir, 'created.txt', 'untracked');
      expect(existsSync(join(dir, 'created.txt'))).toBe(false);
    });
  });

  describe('gitError', () => {
    it('creates a discriminated AppError for failed commands', () => {
      const err = gitError.commandFailed('rev-parse HEAD', 'not a git repository');
      expect(err).toBeInstanceOf(Error);
      expect(err.kind).toBe('git-command-failed');
      expect(err.message).toContain('rev-parse HEAD');
      expect(err.message).toContain('not a git repository');
      expect(err.data).toEqual({ intent: 'rev-parse HEAD', causeMessage: 'not a git repository' });
    });

    it('narrows created git command errors', () => {
      const err = gitError.commandFailed('status --porcelain', 'fatal: error');
      expect(gitError.isCommandFailed(err)).toBe(true);
    });

    it('returns false for plain Error', () => {
      expect(gitError.isCommandFailed(new Error('plain'))).toBe(false);
    });

    it('returns false for non-Error values', () => {
      expect(gitError.isCommandFailed('string')).toBe(false);
      expect(gitError.isCommandFailed(null)).toBe(false);
      expect(gitError.isCommandFailed(42)).toBe(false);
    });
  });
});
