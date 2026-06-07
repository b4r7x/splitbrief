import { describe, it, expect } from 'vitest';
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  uniqueProjectFiles,
  getChangedFilesSnapshot,
  readCurrentFileContent,
  restoreDirtyFilesFromSnapshot,
  writeCurrentFileContent,
} from './file-snapshots.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
const itUnix = process.platform === 'win32' ? it.skip : it;

describe('uniqueProjectFiles', () => {
  it('removes duplicates and sorts', () => {
    expect(uniqueProjectFiles(['b.ts', 'a.ts', 'b.ts'])).toEqual(['a.ts', 'b.ts']);
  });

  it('filters out diptych dir files', () => {
    expect(uniqueProjectFiles(['src/a.ts', '.diptych/config.json'])).toEqual(['src/a.ts']);
  });

  it('filters out empty strings', () => {
    expect(uniqueProjectFiles(['a.ts', '', 'b.ts'])).toEqual(['a.ts', 'b.ts']);
  });
});

describe('getChangedFilesSnapshot', () => {
  it('captures snapshot with head and files', async () => {
    const dir = createTempDir('snapshot-test');
    createTestGitRepo(dir);
    const snapshot = await getChangedFilesSnapshot(dir);
    expect(typeof snapshot.head).toBe('string');
    expect(Array.isArray(snapshot.files)).toBe(true);
    cleanupTempDir(dir);
  });
});

describe('confined project file reads', () => {
  itUnix('rejects reading dirty files through final symlinks', async () => {
    const dir = createTempDir('snapshot-symlink-read');
    const outside = createTempDir('snapshot-symlink-outside');
    createTestGitRepo(dir);
    try {
      writeFileSync(join(outside, 'secret.txt'), 'outside-secret');
      mkdirSync(join(dir, 'src'), { recursive: true });
      symlinkSync(join(outside, 'secret.txt'), join(dir, 'src', 'leak.ts'));

      await expect(readCurrentFileContent(dir, 'src/leak.ts')).rejects.toThrow(/unsafe path/);
    } finally {
      cleanupTempDir(outside);
      cleanupTempDir(dir);
    }
  });

  itUnix('restoreDirtyFilesFromSnapshot uses confined delete for removed files', async () => {
    const dir = createTempDir('snapshot-restore-delete');
    const outside = createTempDir('snapshot-restore-outside');
    createTestGitRepo(dir);
    try {
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(dir, 'src', 'temp.ts'), 'temp');
      const snapshot = await getChangedFilesSnapshot(dir);
      rmSync(join(dir, 'src', 'temp.ts'));
      writeFileSync(join(outside, 'victim.txt'), 'must-not-delete');
      symlinkSync(join(outside, 'victim.txt'), join(dir, 'src', 'temp.ts'));

      await expect(restoreDirtyFilesFromSnapshot(dir, snapshot, ['src/temp.ts'])).rejects.toThrow(
        /unsafe path/,
      );
      expect(join(outside, 'victim.txt')).toBeTruthy();
    } finally {
      cleanupTempDir(outside);
      cleanupTempDir(dir);
    }
  });

  itUnix('writeCurrentFileContent rejects writing through final symlinks', async () => {
    const dir = createTempDir('snapshot-symlink-write');
    const outside = createTempDir('snapshot-symlink-write-outside');
    createTestGitRepo(dir);
    try {
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(outside, 'target.txt'), 'outside');
      symlinkSync(join(outside, 'target.txt'), join(dir, 'src', 'linked.ts'));

      await expect(writeCurrentFileContent(dir, 'src/linked.ts', 'new')).rejects.toThrow(
        /unsafe path/,
      );
    } finally {
      cleanupTempDir(outside);
      cleanupTempDir(dir);
    }
  });
});
