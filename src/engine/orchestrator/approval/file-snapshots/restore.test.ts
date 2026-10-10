import { existsSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { setupProject } from '#testing/helpers/queue.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import type { ChangedFilesSnapshot } from '../../../../core/schemas/workflow.js';
import { restoreDirtyFilesFromSnapshot } from './restore.js';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) cleanupTempDir(directory);
});

it('reports only successfully removed paths and preserves conflicted files and restored symlinks', async () => {
  const { projectDir } = setupProject(directories);
  mkdirSync(join(projectDir, 'src'));
  for (const file of ['kept.ts', 'new.ts', 'conflict.ts', 'link.ts']) {
    writeFileSync(join(projectDir, 'src', file), 'changed\n');
  }
  const snapshot: ChangedFilesSnapshot = {
    head: 'saved-head',
    files: [],
    dirtyFileContents: {
      'src/kept.ts': 'original\n',
      'src/new.ts': null,
      'src/conflict.ts': null,
    },
    symlinks: { 'src/link.ts': 'kept.ts' },
    gitlinks: ['submodule'],
  };

  const result = await restoreDirtyFilesFromSnapshot(
    projectDir,
    snapshot,
    ['src/kept.ts', 'src/new.ts', 'src/conflict.ts', 'src/link.ts', 'submodule'],
    { 'src/conflict.ts': 'before approval\n' },
  );

  expect(result).toEqual({
    restoredFiles: ['src/kept.ts', 'src/new.ts', 'src/link.ts'],
    removedPaths: ['src/new.ts'],
    conflictedFiles: ['src/conflict.ts', 'submodule'],
  });
  expect(readFileSync(join(projectDir, 'src/kept.ts'), 'utf8')).toBe('original\n');
  expect(existsSync(join(projectDir, 'src/new.ts'))).toBe(false);
  expect(readFileSync(join(projectDir, 'src/conflict.ts'), 'utf8')).toBe('changed\n');
  expect(readlinkSync(join(projectDir, 'src/link.ts'))).toBe('kept.ts');
});
