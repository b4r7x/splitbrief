import { describe, it, expect } from 'vitest';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  captureChangedFilesBaseline,
  changedFilesSinceBaseline,
  deserializeChangedFilesBaseline,
  serializeChangedFilesBaseline,
  userVisibleChangedFiles,
  withActiveTaskSnapshot,
} from './changed-files-baseline.js';
import { commitChanges, stageAll } from '../../lib/git.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';

const itUnix = process.platform === 'win32' ? it.skip : it;

describe('userVisibleChangedFiles', () => {
  it('drops worktree and diptych artifacts at any directory level', () => {
    expect(
      userVisibleChangedFiles([
        'src/a.ts',
        '.trees/feat/src/b.ts',
        'sub/.trees/feat/c.ts',
        '.diptych/state.json',
      ]),
    ).toEqual(['src/a.ts']);
  });
});

describe('captureChangedFilesBaseline', () => {
  itUnix('treats symlinked changed files as missing fingerprints', async () => {
    const dir = createTempDir('changed-files-baseline-symlink');
    const outside = createTempDir('changed-files-baseline-outside');
    createTestGitRepo(dir);
    try {
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(outside, 'secret.ts'), 'outside');
      mkdirSync(join(dir, 'src'), { recursive: true });
      symlinkSync(join(outside, 'secret.ts'), join(dir, 'src', 'leak.ts'));

      const baseline = await captureChangedFilesBaseline(dir, ['src/leak.ts']);
      expect(baseline.fingerprints.get('src/leak.ts')).toBe('missing');
    } finally {
      cleanupTempDir(outside);
      cleanupTempDir(dir);
    }
  });

  it('treats a non-confinement read error as a missing fingerprint', async () => {
    const dir = createTempDir('changed-files-baseline-absolute');
    createTestGitRepo(dir);
    try {
      const absolute = join(dir, 'src', 'a.ts');
      const baseline = await captureChangedFilesBaseline(dir, [absolute]);
      expect(baseline.fingerprints.get(absolute)).toBe('missing');
    } finally {
      cleanupTempDir(dir);
    }
  });
});

describe('changed-files baseline persistence', () => {
  it('round-trips the active task snapshot when one is present', () => {
    const baseline = withActiveTaskSnapshot(
      {
        head: 'abc123',
        fingerprints: new Map([['src/a.ts', 'hash-a']]),
      },
      {
        head: 'abc123',
        files: ['src/a.ts'],
        dirtyFileContents: { 'src/a.ts': 'user edit a\n' },
      },
    );

    const persisted = serializeChangedFilesBaseline(baseline);
    const deserialized = deserializeChangedFilesBaseline(persisted);

    expect(persisted.activeTaskSnapshot?.dirtyFileContents['src/a.ts']).toBe('user edit a\n');
    expect(deserialized.activeTaskSnapshot?.dirtyFileContents['src/a.ts']).toBe('user edit a\n');
  });
});

describe('changedFilesSinceBaseline committed leg', () => {
  it('surfaces a user edit that was swept into a commit after the baseline', async () => {
    const dir = createTempDir('changed-files-baseline-committed');
    createTestGitRepo(dir);
    try {
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(dir, 'src', 'a.ts'), 'original\n');
      await stageAll(dir);
      await commitChanges(dir, 'seed');

      const baseline = await captureChangedFilesBaseline(dir);
      expect(await changedFilesSinceBaseline(dir, baseline)).toEqual([]);

      // A user edit lands and is then committed (mirrors a per-task commit that
      // sweeps the edit into history, leaving the working tree clean).
      writeFileSync(join(dir, 'src', 'a.ts'), 'user edit\n');
      await stageAll(dir);
      await commitChanges(dir, 'commit that swept the user edit');

      expect(await changedFilesSinceBaseline(dir, baseline)).toEqual(['src/a.ts']);
    } finally {
      cleanupTempDir(dir);
    }
  });
});
