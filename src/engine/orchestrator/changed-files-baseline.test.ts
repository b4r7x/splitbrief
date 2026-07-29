import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { chmodSync, lstatSync, mkdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  captureChangedFilesBaseline,
  changedFilesSinceBaseline,
  deserializeChangedFilesBaseline,
  refreshChangedFilesBaseline,
  serializeChangedFilesBaseline,
  userVisibleChangedFiles,
  withActiveTaskSnapshot,
} from './changed-files-baseline.js';
import { commitChanges, stageAll } from '../../lib/git/staging.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';

const itUnix = process.platform === 'win32' ? it.skip : it;

describe('userVisibleChangedFiles', () => {
  it('drops worktree and splitbrief artifacts at any directory level', () => {
    expect(
      userVisibleChangedFiles([
        'src/a.ts',
        '.trees/feat/src/b.ts',
        'sub/.trees/feat/c.ts',
        '.splitbrief/state.json',
      ]),
    ).toEqual(['src/a.ts']);
  });
});

describe('captureChangedFilesBaseline', () => {
  itUnix('rejects an existing final symlink without reading its target', async () => {
    const dir = createTempDir('changed-files-baseline-symlink');
    const outside = createTempDir('changed-files-baseline-outside');
    createTestGitRepo(dir);
    try {
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(outside, 'secret.ts'), 'outside');
      symlinkSync(join(outside, 'secret.ts'), join(dir, 'src', 'leak.ts'));

      await expect(captureChangedFilesBaseline(dir, ['src/leak.ts'])).rejects.toMatchObject({
        kind: 'path-symlink-read',
      });
    } finally {
      cleanupTempDir(outside);
      cleanupTempDir(dir);
    }
  });

  itUnix('rejects a dangling final symlink instead of treating it as missing', async () => {
    const dir = createTempDir('changed-files-baseline-dangling-symlink');
    createTestGitRepo(dir);
    try {
      mkdirSync(join(dir, 'src'), { recursive: true });
      symlinkSync('missing.ts', join(dir, 'src', 'dangling.ts'));

      await expect(captureChangedFilesBaseline(dir, ['src/dangling.ts'])).rejects.toMatchObject({
        kind: 'path-symlink-read',
      });
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('rejects absolute changed-file paths', async () => {
    const dir = createTempDir('changed-files-baseline-absolute');
    createTestGitRepo(dir);
    try {
      const absolute = join(dir, 'src', 'a.ts');
      await expect(captureChangedFilesBaseline(dir, [absolute])).rejects.toMatchObject({
        kind: 'path-confined-absolute',
      });
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('propagates an operational failure while fingerprinting an existing path', async () => {
    const dir = createTempDir('changed-files-baseline-read-failure');
    createTestGitRepo(dir);
    try {
      mkdirSync(join(dir, 'unreadable'));

      await expect(captureChangedFilesBaseline(dir, ['unreadable'])).rejects.toMatchObject({
        kind: 'changed-file-fingerprint-read',
        data: { file: 'unreadable' },
        cause: expect.objectContaining({ code: 'EISDIR' }),
      });
    } finally {
      cleanupTempDir(dir);
    }
  });

  itUnix(
    'wraps an EACCES from initial path inspection without classifying the file as missing',
    async ({ skip }) => {
      const dir = createTempDir('changed-files-baseline-inspection-eacces');
      const blockedDir = join(dir, 'blocked');
      const filePath = join(blockedDir, 'secret.ts');
      createTestGitRepo(dir);
      try {
        mkdirSync(blockedDir);
        writeFileSync(filePath, 'export const secret = true;\n');
        chmodSync(blockedDir, 0o000);

        try {
          lstatSync(filePath);
          skip('filesystem permissions are ineffective for this user');
          return;
        } catch (cause) {
          expect(cause).toMatchObject({ code: 'EACCES' });
        }

        await expect(captureChangedFilesBaseline(dir, ['blocked/secret.ts'])).rejects.toMatchObject(
          {
            kind: 'changed-file-fingerprint-read',
            data: { file: 'blocked/secret.ts' },
            cause: expect.objectContaining({ code: 'EACCES' }),
          },
        );
      } finally {
        chmodSync(blockedDir, 0o700);
        cleanupTempDir(dir);
      }
    },
  );
});

describe('changed-files baseline persistence', () => {
  it('keeps run-start paths empty while rolling fingerprints absorb a later file', async () => {
    const dir = createTempDir('changed-files-baseline-run-start-clean');
    createTestGitRepo(dir);
    try {
      const baseline = await captureChangedFilesBaseline(dir);
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(dir, 'src', 'hook-output.ts'), 'export const hookOutput = true;\n');

      const refreshed = await refreshChangedFilesBaseline({
        projectDir: dir,
        baseline,
        absorbedFiles: new Set(['src/hook-output.ts']),
      });
      const persisted = serializeChangedFilesBaseline(refreshed);
      const deserialized = deserializeChangedFilesBaseline(persisted);

      expect(refreshed.fingerprints.has('src/hook-output.ts')).toBe(true);
      expect(persisted.runStartChangedFiles).toEqual([]);
      expect(deserialized.runStartChangedFiles).toBeDefined();
      expect(deserialized.runStartChangedFiles).toEqual(new Set());
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('retains genuinely dirty-at-start paths while rolling fingerprints refresh', async () => {
    const dir = createTempDir('changed-files-baseline-run-start-dirty');
    createTestGitRepo(dir);
    try {
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(dir, 'src', 'dirty.ts'), 'export const dirty = true;\n');
      const baseline = await captureChangedFilesBaseline(dir);
      writeFileSync(join(dir, 'src', 'task-output.ts'), 'export const taskOutput = true;\n');

      const refreshed = await refreshChangedFilesBaseline({
        projectDir: dir,
        baseline,
        absorbedFiles: new Set(['src/task-output.ts']),
      });
      const persisted = serializeChangedFilesBaseline(refreshed);
      const deserialized = deserializeChangedFilesBaseline(persisted);

      expect(refreshed.fingerprints.has('src/task-output.ts')).toBe(true);
      expect(persisted.runStartChangedFiles).toEqual(['src/dirty.ts']);
      expect(deserialized.runStartChangedFiles).toEqual(new Set(['src/dirty.ts']));
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('deserializes legacy payloads without run-start paths', () => {
    const baseline = deserializeChangedFilesBaseline({
      head: 'abc123',
      fingerprints: { 'src/a.ts': 'hash-a' },
    });

    expect(baseline.runStartChangedFiles).toBeUndefined();
  });

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

  it('includes a first commit made after an unborn run start', async () => {
    const dir = createTempDir('changed-files-baseline-unborn');
    try {
      execSync('git init', { cwd: dir, stdio: 'pipe' });
      execSync('git config user.email "t@t.com" && git config user.name "T"', {
        cwd: dir,
        stdio: 'pipe',
      });
      const baseline = await captureChangedFilesBaseline(dir);
      expect(baseline.head).toBeNull();

      writeFileSync(join(dir, 'first.ts'), 'export const first = true;\n');
      await stageAll(dir);
      await commitChanges(dir, 'first commit');

      expect(await changedFilesSinceBaseline(dir, baseline)).toEqual(['first.ts']);
    } finally {
      cleanupTempDir(dir);
    }
  });
});

describe('changed-files rolling disappearance', () => {
  it('reports a tracked dirty file becoming clean', async () => {
    const dir = createTempDir('changed-files-baseline-tracked-clean');
    createTestGitRepo(dir);
    try {
      writeFileSync(join(dir, 'tracked.txt'), 'original\n');
      await stageAll(dir);
      await commitChanges(dir, 'seed tracked file');
      writeFileSync(join(dir, 'tracked.txt'), 'dirty\n');
      const baseline = await captureChangedFilesBaseline(dir);

      writeFileSync(join(dir, 'tracked.txt'), 'original\n');

      expect(await changedFilesSinceBaseline(dir, baseline)).toEqual(['tracked.txt']);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('reports a deleted untracked file', async () => {
    const dir = createTempDir('changed-files-baseline-untracked-delete');
    createTestGitRepo(dir);
    try {
      writeFileSync(join(dir, 'untracked.txt'), 'temporary\n');
      const baseline = await captureChangedFilesBaseline(dir);

      unlinkSync(join(dir, 'untracked.txt'));

      expect(await changedFilesSinceBaseline(dir, baseline)).toEqual(['untracked.txt']);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('stores an absorbed disappearance once and then compares cleanly', async () => {
    const dir = createTempDir('changed-files-baseline-absorb-delete');
    createTestGitRepo(dir);
    try {
      writeFileSync(join(dir, 'gone.txt'), 'temporary\n');
      const baseline = await captureChangedFilesBaseline(dir);
      unlinkSync(join(dir, 'gone.txt'));
      expect(await changedFilesSinceBaseline(dir, baseline)).toEqual(['gone.txt']);

      const refreshed = await refreshChangedFilesBaseline({
        projectDir: dir,
        baseline,
        absorbedFiles: new Set(['gone.txt']),
      });

      expect(refreshed.fingerprints.get('gone.txt')).toBe('missing');
      expect(await changedFilesSinceBaseline(dir, refreshed)).toEqual([]);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('reports a file that reappears after its missing tombstone', async () => {
    const dir = createTempDir('changed-files-baseline-reappear');
    createTestGitRepo(dir);
    try {
      writeFileSync(join(dir, 'returning.txt'), 'first\n');
      const baseline = await captureChangedFilesBaseline(dir);
      unlinkSync(join(dir, 'returning.txt'));
      const refreshed = await refreshChangedFilesBaseline({
        projectDir: dir,
        baseline,
        absorbedFiles: new Set(['returning.txt']),
      });

      writeFileSync(join(dir, 'returning.txt'), 'second\n');

      expect(await changedFilesSinceBaseline(dir, refreshed)).toEqual(['returning.txt']);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('keeps a new nonabsorbed file outside the baseline', async () => {
    const dir = createTempDir('changed-files-baseline-new-file');
    createTestGitRepo(dir);
    try {
      const baseline = await captureChangedFilesBaseline(dir);
      writeFileSync(join(dir, 'new.txt'), 'new\n');

      const refreshed = await refreshChangedFilesBaseline({
        projectDir: dir,
        baseline,
        absorbedFiles: new Set(),
      });

      expect(refreshed.fingerprints.has('new.txt')).toBe(false);
      expect(await changedFilesSinceBaseline(dir, refreshed)).toEqual(['new.txt']);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('serializes a missing tombstone, preserves explicit-empty provenance, and clears active state', async () => {
    const dir = createTempDir('changed-files-baseline-tombstone-persistence');
    createTestGitRepo(dir);
    try {
      const baseline = withActiveTaskSnapshot(await captureChangedFilesBaseline(dir), {
        head: 'abc123',
        files: [],
        dirtyFileContents: {},
      });

      const refreshed = await refreshChangedFilesBaseline({
        projectDir: dir,
        baseline,
        absorbedFiles: new Set(['never-created.txt']),
      });
      const persisted = serializeChangedFilesBaseline(refreshed);
      const deserialized = deserializeChangedFilesBaseline(persisted);

      expect(persisted.fingerprints['never-created.txt']).toBe('missing');
      expect(refreshed.head).toBe(baseline.head);
      expect(refreshed.runStartChangedFiles).toBe(baseline.runStartChangedFiles);
      expect(persisted.runStartChangedFiles).toEqual([]);
      expect(persisted.activeTaskSnapshot).toBeUndefined();
      expect(deserialized.fingerprints.get('never-created.txt')).toBe('missing');
      expect(deserialized.runStartChangedFiles).toEqual(new Set());
    } finally {
      cleanupTempDir(dir);
    }
  });
});
