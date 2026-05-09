import { execSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { cleanupTempDir, createTempDir } from './temp-dir.js';
import { createTestGitRepo } from './git.js';

describe('createTestGitRepo', () => {
  it('creates a clean multi-file repository without staging or committing during the test', () => {
    const dir = createTempDir('git-helper-test');
    try {
      createTestGitRepo(dir, {
        'a.txt': 'a',
        'src/a.ts': 'export const a = 1;\n',
        'longer-name.txt': 'longer\n',
      });

      expect(execSync('git status --porcelain=v1 -uall', { cwd: dir, encoding: 'utf-8' })).toBe('');
      expect(execSync('git ls-files', { cwd: dir, encoding: 'utf-8' }).trim().split('\n')).toEqual([
        'a.txt',
        'init.txt',
        'longer-name.txt',
        'src/a.ts',
      ]);
    } finally {
      cleanupTempDir(dir);
    }
  });
});
