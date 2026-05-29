import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  isGitRepo,
  getCurrentDiff,
  getCurrentChangedFiles,
  discardFileChange,
  discardChangedFiles,
  branchExists,
  createBranch,
  checkIgnoredPaths,
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

  describe('getCurrentChangedFiles', () => {
    it('returns modified file paths', async () => {
      const dir = tracked(setupGitRepo());
      writeFileSync(join(dir, 'init.txt'), 'modified');
      const files = await getCurrentChangedFiles(dir);
      expect(files).toContain('init.txt');
    });

    it('returns empty array for clean working tree', async () => {
      const dir = tracked(setupGitRepo());
      const files = await getCurrentChangedFiles(dir);
      expect(files).toEqual([]);
    });

    it('includes new untracked files', async () => {
      const dir = tracked(setupGitRepo());
      writeFileSync(join(dir, 'new-file.txt'), 'content');
      const files = await getCurrentChangedFiles(dir);
      expect(files).toContain('new-file.txt');
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

  describe('discardChangedFiles', () => {
    it('discards both tracked and untracked files', async () => {
      const dir = tracked(setupGitRepo());
      writeFileSync(join(dir, 'init.txt'), 'modified');
      writeFileSync(join(dir, 'created.txt'), 'new file');

      await discardChangedFiles(dir, ['init.txt', 'created.txt']);

      expect(readFileSync(join(dir, 'init.txt'), 'utf-8')).toBe('init');
      expect(existsSync(join(dir, 'created.txt'))).toBe(false);
    });
  });

  describe('runGit error wrapping', () => {
    it('wraps a failed simple-git call as a typed GitCommandError', async () => {
      const dir = tracked(createTempDir('diptych-nogit-diff'));
      await expect(getCurrentDiff(dir)).rejects.toSatisfy(gitError.isCommandFailed);
    });
  });

  describe('checkIgnoredPaths', () => {
    it('returns empty array for empty input', async () => {
      const dir = tracked(setupGitRepo());
      const result = await checkIgnoredPaths(dir, []);
      expect(result).toEqual([]);
    });

    it('identifies gitignored paths via stdin', async () => {
      const dir = tracked(setupGitRepo());
      writeFileSync(join(dir, '.gitignore'), '*.log\ndist/\n');
      mkdirSync(join(dir, 'dist'), { recursive: true });
      writeFileSync(join(dir, 'debug.log'), 'x');
      writeFileSync(join(dir, 'dist', 'bundle.js'), 'x');
      writeFileSync(join(dir, 'src.ts'), 'export {}');

      const result = await checkIgnoredPaths(dir, ['debug.log', 'dist/bundle.js', 'src.ts']);
      expect(result).toContain('debug.log');
      expect(result).toContain('dist/bundle.js');
      expect(result).not.toContain('src.ts');
    });

    it('handles paths with spaces', async () => {
      const dir = tracked(setupGitRepo());
      writeFileSync(join(dir, '.gitignore'), '*.log\n');
      writeFileSync(join(dir, 'my file.log'), 'x');

      const result = await checkIgnoredPaths(dir, ['my file.log']);
      expect(result).toContain('my file.log');
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
