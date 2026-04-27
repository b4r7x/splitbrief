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
  createCheckpoint,
  discardTaskChanges,
  branchExists,
  createBranch,
  createGitCommandError,
  isGitCommandError,
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

  describe('createCheckpoint', () => {
    it('creates a tagged stash sha for dirty working tree and returns its tag', async () => {
      const dir = tracked(setupGitRepo());
      writeFileSync(join(dir, 'init.txt'), 'modified');
      const tag = await createCheckpoint(dir, 'T001');
      expect(tag).toBe('diptych/T001');
      const tags = execSync('git tag', { cwd: dir, encoding: 'utf-8' });
      expect(tags).toContain('diptych/T001');
    });

    it('returns empty string when there is nothing to stash', async () => {
      const dir = tracked(setupGitRepo());
      const tag = await createCheckpoint(dir, 'T002');
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

  describe('discardTaskChanges', () => {
    it('checks out modified file on modify action', async () => {
      const dir = tracked(setupGitRepo());
      writeFileSync(join(dir, 'init.txt'), 'modified');
      await discardTaskChanges(dir, 'init.txt', 'modify');
      const content = readFileSync(join(dir, 'init.txt'), 'utf-8');
      expect(content).toBe('init');
    });

    it('cleans created file on create action', async () => {
      const dir = tracked(setupGitRepo());
      writeFileSync(join(dir, 'created.txt'), 'new file');
      await discardTaskChanges(dir, 'created.txt', 'create');
      expect(existsSync(join(dir, 'created.txt'))).toBe(false);
    });
  });

  describe('createGitCommandError / isGitCommandError', () => {
    it('creates an Error with intent and causeMessage fields', () => {
      const err = createGitCommandError('rev-parse HEAD', 'not a git repository');
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toContain('rev-parse HEAD');
      expect(err.message).toContain('not a git repository');
      expect(err.intent).toBe('rev-parse HEAD');
      expect(err.causeMessage).toBe('not a git repository');
    });

    it('isGitCommandError returns true for created errors', () => {
      const err = createGitCommandError('status --porcelain', 'fatal: error');
      expect(isGitCommandError(err)).toBe(true);
    });

    it('isGitCommandError returns false for plain Error', () => {
      expect(isGitCommandError(new Error('plain'))).toBe(false);
    });

    it('isGitCommandError returns false for non-Error values', () => {
      expect(isGitCommandError('string')).toBe(false);
      expect(isGitCommandError(null)).toBe(false);
      expect(isGitCommandError(42)).toBe(false);
    });
  });
});
