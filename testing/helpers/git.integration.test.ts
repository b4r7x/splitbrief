import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cleanupTempDir, createTempDir } from './temp-dir.js';
import { createTestGitRepo } from './git.js';

describe('createTestGitRepo', () => {
  it('matches git init configuration without the host excludes file and supports another commit on main', () => {
    const fixtureDir = createTempDir('git-helper-fixture');
    const initializedDir = createTempDir('git-helper-initialized');
    try {
      createTestGitRepo(fixtureDir);
      const hostFreeEnv = {
        ...process.env,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
      };
      execSync('git init', {
        cwd: initializedDir,
        stdio: 'pipe',
        env: hostFreeEnv,
      });
      execSync('git config user.email "test@test.com"', {
        cwd: initializedDir,
        stdio: 'pipe',
        env: hostFreeEnv,
      });
      execSync('git config user.name "Test"', {
        cwd: initializedDir,
        stdio: 'pipe',
        env: hostFreeEnv,
      });
      const config = (cwd: string) =>
        execSync('git config --file .git/config --list', { cwd, encoding: 'utf8' })
          .trim()
          .split('\n')
          .sort();

      expect(config(fixtureDir)).toEqual(
        [...config(initializedDir), 'core.excludesfile=/dev/null'].sort(),
      );
      expect(
        execSync('git rev-parse --abbrev-ref HEAD', { cwd: fixtureDir, encoding: 'utf8' }).trim(),
      ).toBe('main');
      expect(readFileSync(join(fixtureDir, '.git', 'info', 'exclude'), 'utf8')).toBe(
        readFileSync(join(initializedDir, '.git', 'info', 'exclude'), 'utf8'),
      );
      expect(() =>
        execSync('git commit --allow-empty -m next', { cwd: fixtureDir, stdio: 'pipe' }),
      ).not.toThrow();
    } finally {
      cleanupTempDir(fixtureDir);
      cleanupTempDir(initializedDir);
    }
  });

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
