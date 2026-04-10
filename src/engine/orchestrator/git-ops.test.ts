import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { discardTaskChanges } from './git-ops.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';

function setupGitRepo(): string {
  const dir = createTempDir('tiny-spec-git-ops-test');
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

describe('git-ops', () => {
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
