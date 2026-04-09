import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import { isGitRepo, commitChanges, getCurrentDiff, hasExternalChanges, discardTaskChanges } from './git.js';

function setupGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tiny-spec-git-test-'));
  execSync('git init', { cwd: dir, stdio: 'ignore' });
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'ignore' });
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'ignore' });
  writeFileSync(join(dir, 'init.txt'), 'init');
  execSync('git add . && git commit -m "init"', { cwd: dir, stdio: 'ignore' });
  return dir;
}

let dirs: string[] = [];

afterEach(() => {
  for (const d of dirs) {
    if (existsSync(d)) rmSync(d, { recursive: true, force: true });
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
      const dir = tracked(mkdtempSync(join(tmpdir(), 'tiny-spec-nogit-')));
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
});
