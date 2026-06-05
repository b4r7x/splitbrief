import { afterEach, describe, it, expect, vi } from 'vitest';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';

const control = vi.hoisted(() => ({
  failCp: false,
  failLstatBasename: '',
  lastStagedRoot: '',
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    mkdtemp: async (...args: Parameters<typeof actual.mkdtemp>) => {
      const root = await actual.mkdtemp(...args);
      control.lastStagedRoot = root as string;
      return root;
    },
    cp: (...args: Parameters<typeof actual.cp>) => {
      if (control.failCp) return Promise.reject(new Error('ENOSPC: simulated copy failure'));
      return actual.cp(...args);
    },
    lstat: (path: Parameters<typeof actual.lstat>[0], ...rest: unknown[]) => {
      if (
        control.failLstatBasename &&
        typeof path === 'string' &&
        path.endsWith(control.failLstatBasename)
      ) {
        return Promise.reject(new Error('EIO: simulated lstat failure'));
      }
      return (actual.lstat as (...a: unknown[]) => unknown)(path, ...rest);
    },
  };
});

const { createStagedProject } = await import('./staged-project.js');

const itUnix = process.platform === 'win32' ? it.skip : it;

let dirs: string[] = [];

afterEach(() => {
  control.failCp = false;
  control.failLstatBasename = '';
  control.lastStagedRoot = '';
  for (const dir of dirs) cleanupTempDir(dir);
  dirs = [];
});

describe('createStagedProject — failure handling', () => {
  it('propagates an unexpected lstat error instead of silently dropping a regular file', async () => {
    const dir = createTempDir('staged-lstat-error');
    dirs.push(dir);
    createTestGitRepo(dir);
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'app.ts'), 'export const app = true;\n');

    control.failLstatBasename = 'app.ts';
    await expect(createStagedProject(dir)).rejects.toThrow(/simulated lstat failure/);
  });

  itUnix('removes the temp staging directory when copying fails', async () => {
    const dir = createTempDir('staged-cp-error');
    dirs.push(dir);
    createTestGitRepo(dir);
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'app.ts'), 'export const app = true;\n');

    control.failCp = true;
    await expect(createStagedProject(dir)).rejects.toThrow(/simulated copy failure/);
    expect(control.lastStagedRoot).not.toBe('');
    expect(existsSync(control.lastStagedRoot)).toBe(false);
  });
});
