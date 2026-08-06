import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { chmodSync, lstatSync, mkdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  UNREADABLE_FINGERPRINT,
  captureChangedFilesBaseline,
  changedFilesSinceBaseline,
  deserializeChangedFilesBaseline,
  refreshChangedFilesBaseline,
  serializeChangedFilesBaseline,
  unreadableChangedFiles,
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
  itUnix('records an existing final symlink as unreadable without reading its target', async () => {
    const dir = createTempDir('changed-files-baseline-symlink');
    const outside = createTempDir('changed-files-baseline-outside');
    createTestGitRepo(dir);
    try {
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(outside, 'secret.ts'), 'outside');
      symlinkSync(join(outside, 'secret.ts'), join(dir, 'src', 'leak.ts'));

      const baseline = await captureChangedFilesBaseline(dir, ['src/leak.ts']);

      expect(baseline.fingerprints.get('src/leak.ts')).toBe(UNREADABLE_FINGERPRINT);
    } finally {
      cleanupTempDir(outside);
      cleanupTempDir(dir);
    }
  });

  itUnix('records a dangling final symlink as unreadable, not as missing', async () => {
    const dir = createTempDir('changed-files-baseline-dangling-symlink');
    createTestGitRepo(dir);
    try {
      mkdirSync(join(dir, 'src'), { recursive: true });
      symlinkSync('missing.ts', join(dir, 'src', 'dangling.ts'));

      const baseline = await captureChangedFilesBaseline(dir, ['src/dangling.ts']);

      expect(baseline.fingerprints.get('src/dangling.ts')).toBe(UNREADABLE_FINGERPRINT);
      expect(baseline.fingerprints.get('src/dangling.ts')).not.toBe('missing');
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

  it('records an unreadable entry while other changed files still fingerprint', async () => {
    const dir = createTempDir('changed-files-baseline-read-failure');
    createTestGitRepo(dir);
    try {
      mkdirSync(join(dir, 'unreadable'));
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(dir, 'src', 'ok.ts'), 'export const ok = true;\n');

      const baseline = await captureChangedFilesBaseline(dir, ['unreadable', 'src/ok.ts']);

      expect(baseline.fingerprints.get('unreadable')).toBe(UNREADABLE_FINGERPRINT);
      expect(baseline.fingerprints.get('src/ok.ts')).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      cleanupTempDir(dir);
    }
  });

  itUnix(
    'records an EACCES entry as unreadable instead of classifying the file as missing',
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

        const baseline = await captureChangedFilesBaseline(dir, ['blocked/secret.ts']);

        expect(baseline.fingerprints.get('blocked/secret.ts')).toBe(UNREADABLE_FINGERPRINT);
      } finally {
        chmodSync(blockedDir, 0o700);
        cleanupTempDir(dir);
      }
    },
  );

  itUnix('reports an entry unreadable at both ends as unchanged', async () => {
    const dir = createTempDir('changed-files-baseline-unreadable-both-ends');
    const outside = createTempDir('changed-files-baseline-outside-both-ends');
    createTestGitRepo(dir);
    try {
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(outside, 'secret.ts'), 'outside');
      symlinkSync(join(outside, 'secret.ts'), join(dir, 'src', 'leak.ts'));

      const baseline = await captureChangedFilesBaseline(dir, ['src/leak.ts']);

      expect(await changedFilesSinceBaseline(dir, baseline)).toEqual([]);
    } finally {
      cleanupTempDir(outside);
      cleanupTempDir(dir);
    }
  });

  itUnix('reports a regular file replaced by a symlink after the baseline as changed', async () => {
    const dir = createTempDir('changed-files-baseline-replaced-by-symlink');
    const outside = createTempDir('changed-files-baseline-outside-replaced');
    createTestGitRepo(dir);
    try {
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(dir, 'src', 'swap.ts'), 'original\n');
      await stageAll(dir);
      await commitChanges(dir, 'seed swap file');
      const baseline = await captureChangedFilesBaseline(dir);

      unlinkSync(join(dir, 'src', 'swap.ts'));
      writeFileSync(join(outside, 'secret.ts'), 'outside');
      symlinkSync(join(outside, 'secret.ts'), join(dir, 'src', 'swap.ts'));

      expect(await changedFilesSinceBaseline(dir, baseline)).toEqual(['src/swap.ts']);
    } finally {
      cleanupTempDir(outside);
      cleanupTempDir(dir);
    }
  });
});

describe('unreadableChangedFiles', () => {
  itUnix('returns the sorted project-relative paths of unreadable entries', async () => {
    const dir = createTempDir('changed-files-baseline-unreadable-list');
    const outside = createTempDir('changed-files-baseline-unreadable-list-outside');
    createTestGitRepo(dir);
    try {
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(outside, 'secret.ts'), 'outside');
      symlinkSync(join(outside, 'secret.ts'), join(dir, 'src', 'leak.ts'));
      mkdirSync(join(dir, 'zzz'), { recursive: true });

      const baseline = await captureChangedFilesBaseline(dir, ['src/leak.ts', 'zzz']);

      expect(unreadableChangedFiles(baseline)).toEqual(['src/leak.ts', 'zzz']);
    } finally {
      cleanupTempDir(outside);
      cleanupTempDir(dir);
    }
  });
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
