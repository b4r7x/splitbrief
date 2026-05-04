import { describe, it, expect } from 'vitest';
import { uniqueProjectFiles, getChangedFilesSnapshot } from './file-snapshots.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';

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
