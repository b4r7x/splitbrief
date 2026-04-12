import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { isGitRepo, commitChanges, getCurrentDiff, hasExternalChanges, ensureGitignore, getChangedFiles } from './git.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';

function setupGitRepo(): string {
  const dir = createTempDir('tiny-spec-git-test');
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
      const dir = tracked(createTempDir('tiny-spec-nogit'));
      expect(await isGitRepo(dir)).toBe(false);
    });
  });

  describe('commitChanges', () => {
    it('stages and commits, returns a hash', async () => {
      const dir = tracked(setupGitRepo());
      writeFileSync(join(dir, 'new.txt'), 'hello');
      const hash = await commitChanges(dir, 'add new file');
      expect(hash).toBeTruthy();
      expect(typeof hash).toBe('string');
      const log = execSync('git log --oneline', { cwd: dir, encoding: 'utf-8' });
      expect(log).toContain('add new file');
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

  describe('ensureGitignore', () => {
    it('creates .gitignore with entry when file does not exist', () => {
      const dir = tracked(createTempDir('tiny-spec-gitignore'));
      ensureGitignore(dir, '.tiny-spec/');
      const content = readFileSync(join(dir, '.gitignore'), 'utf-8');
      expect(content).toBe('.tiny-spec/\n');
    });

    it('appends entry to existing .gitignore', () => {
      const dir = tracked(createTempDir('tiny-spec-gitignore'));
      writeFileSync(join(dir, '.gitignore'), 'node_modules/\n');
      ensureGitignore(dir, '.tiny-spec/');
      const content = readFileSync(join(dir, '.gitignore'), 'utf-8');
      expect(content).toContain('node_modules/');
      expect(content).toContain('.tiny-spec/');
    });

    it('does not duplicate entry if already present', () => {
      const dir = tracked(createTempDir('tiny-spec-gitignore'));
      writeFileSync(join(dir, '.gitignore'), '.tiny-spec/\n');
      ensureGitignore(dir, '.tiny-spec/');
      const content = readFileSync(join(dir, '.gitignore'), 'utf-8');
      const matches = content.split('\n').filter(l => l.trim() === '.tiny-spec/');
      expect(matches).toHaveLength(1);
    });

    it('does not produce double blank lines when file lacks trailing newline', () => {
      const dir = tracked(createTempDir('tiny-spec-gitignore'));
      writeFileSync(join(dir, '.gitignore'), 'node_modules/');
      ensureGitignore(dir, '.tiny-spec/');
      const content = readFileSync(join(dir, '.gitignore'), 'utf-8');
      expect(content).not.toContain('\n\n');
      expect(content).toContain('.tiny-spec/');
    });
  });

});
