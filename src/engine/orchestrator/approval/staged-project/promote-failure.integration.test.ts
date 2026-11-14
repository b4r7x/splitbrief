import { afterEach, describe, expect, vi } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { itUnix } from '#testing/helpers/staged-project-failure.js';

const control = vi.hoisted(() => ({
  failWriteBasename: '',
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      if (
        control.failWriteBasename &&
        String(args[0]).includes(`.${control.failWriteBasename}.tmp.`)
      ) {
        handle.writeFile = async () => {
          throw new Error('EIO: simulated write failure');
        };
      }
      return handle;
    },
  };
});

const { promoteStagedChanges } = await import('./promote.js');
const { captureAcquisitionBaseline } = await import('../file-snapshots/entry/baseline.js');

let dirs: string[] = [];

afterEach(() => {
  control.failWriteBasename = '';
  for (const dir of dirs) cleanupTempDir(dir);
  dirs = [];
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
