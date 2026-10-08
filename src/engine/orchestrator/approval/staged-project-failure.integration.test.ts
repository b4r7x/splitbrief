import { afterEach, describe, it, expect, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';

const control = vi.hoisted(() => ({
  failCp: false,
  failLstatBasename: '',
  failWriteBasename: '',
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
    copyFile: (...args: Parameters<typeof actual.copyFile>) => {
      if (control.failCp) return Promise.reject(new Error('ENOSPC: simulated copy failure'));
      return actual.copyFile(...args);
    },
    writeFile: (path: Parameters<typeof actual.writeFile>[0], ...rest: unknown[]) => {
      if (
        control.failWriteBasename &&
        typeof path === 'string' &&
        (path.endsWith(control.failWriteBasename) ||
          path.includes(`.${control.failWriteBasename}.tmp.`))
      ) {
        return Promise.reject(new Error('EIO: simulated write failure'));
      }
      return (actual.writeFile as (...a: unknown[]) => unknown)(path, ...rest);
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

const { createStagedProject, promoteStagedChanges } = await import('./staged-project.js');
const { captureAcquisitionBaseline } = await import('./file-snapshots/entry.js');

const itUnix = process.platform === 'win32' ? it.skip : it;

let dirs: string[] = [];

afterEach(() => {
  control.failCp = false;
  control.failLstatBasename = '';
  control.failWriteBasename = '';
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
    await expect(createStagedProject({ projectDir: dir })).rejects.toThrow(
      /simulated lstat failure/,
    );
  });

  itUnix('removes the temp staging directory when copying fails', async () => {
    const dir = createTempDir('staged-cp-error');
    dirs.push(dir);
    createTestGitRepo(dir);
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'app.ts'), 'export const app = true;\n');

    control.failCp = true;
    await expect(createStagedProject({ projectDir: dir })).rejects.toThrow(
      /simulated copy failure/,
    );
    expect(control.lastStagedRoot).not.toBe('');
    expect(existsSync(control.lastStagedRoot)).toBe(false);
  });
});

const PROMOTED_FILES = ['src/a.ts', 'src/b.ts', 'src/c.ts'];

function setUpPromotion(): { projectDir: string; stagedDir: string } {
  const projectDir = createTempDir('promote-failure-project');
  const stagedDir = createTempDir('promote-failure-staged');
  dirs.push(projectDir, stagedDir);
  mkdirSync(join(projectDir, 'src'), { recursive: true });
  mkdirSync(join(stagedDir, 'src'), { recursive: true });
  for (const file of PROMOTED_FILES) {
    writeFileSync(join(projectDir, file), `target ${file}\n`);
    writeFileSync(join(stagedDir, file), `staged ${file}\n`);
  }
  return { projectDir, stagedDir };
}

describe('promoteStagedChanges — partial apply', () => {
  itUnix('reports the applied prefix and stops when a write fails mid-promotion', async () => {
    const { projectDir, stagedDir } = setUpPromotion();
    const targetBaseline = await captureAcquisitionBaseline(projectDir);

    control.failWriteBasename = 'b.ts';
    const result = await promoteStagedChanges({
      targetProjectDir: projectDir,
      stagedProjectDir: stagedDir,
      files: PROMOTED_FILES,
      targetBaseline,
    });

    expect(result.promotedFiles).toEqual(['src/a.ts']);
    expect(result.conflictedFiles).toEqual([]);
    expect(result.failure?.failedFile).toBe('src/b.ts');
    expect(result.failure?.error).toBeInstanceOf(Error);
    expect(String(result.failure?.error)).toMatch(/simulated write failure/);

    expect(readFileSync(join(projectDir, 'src/a.ts'), 'utf8')).toBe('staged src/a.ts\n');
    expect(readFileSync(join(projectDir, 'src/b.ts'), 'utf8')).toBe('target src/b.ts\n');
    expect(readFileSync(join(projectDir, 'src/c.ts'), 'utf8')).toBe('target src/c.ts\n');
  });

  itUnix('returns an empty prefix when the very first write fails', async () => {
    const { projectDir, stagedDir } = setUpPromotion();
    const targetBaseline = await captureAcquisitionBaseline(projectDir);

    control.failWriteBasename = 'a.ts';
    const result = await promoteStagedChanges({
      targetProjectDir: projectDir,
      stagedProjectDir: stagedDir,
      files: PROMOTED_FILES,
      targetBaseline,
    });

    expect(result.promotedFiles).toEqual([]);
    expect(result.failure?.failedFile).toBe('src/a.ts');
    for (const file of PROMOTED_FILES) {
      expect(readFileSync(join(projectDir, file), 'utf8')).toBe(`target ${file}\n`);
    }
  });

  itUnix('keeps a user edit to an already promoted file; nothing rolls back', async () => {
    const { projectDir, stagedDir } = setUpPromotion();
    const targetBaseline = await captureAcquisitionBaseline(projectDir);

    control.failWriteBasename = 'b.ts';
    const first = await promoteStagedChanges({
      targetProjectDir: projectDir,
      stagedProjectDir: stagedDir,
      files: PROMOTED_FILES,
      targetBaseline,
    });
    expect(first.promotedFiles).toEqual(['src/a.ts']);

    writeFileSync(join(projectDir, 'src/a.ts'), 'user edit\n');

    control.failWriteBasename = '';
    const retry = await promoteStagedChanges({
      targetProjectDir: projectDir,
      stagedProjectDir: stagedDir,
      files: PROMOTED_FILES,
      targetBaseline,
    });

    expect(retry.promotedFiles).toEqual([]);
    expect(retry.conflictedFiles).toEqual(['src/a.ts']);
    expect(retry.failure).toBeUndefined();
    expect(readFileSync(join(projectDir, 'src/a.ts'), 'utf8')).toBe('user edit\n');
  });
});
