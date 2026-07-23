import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getChangedFilesSinceSnapshot, getChangedFilesSnapshot } from './capture.js';
import { restoreDirtyFilesFromSnapshot } from './restore.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
const itUnix = process.platform === 'win32' ? it.skip : it;

function createSuperprojectWithSubmodule(root: string): { project: string; submodule: string } {
  const sub = join(root, 'subrepo');
  mkdirSync(sub, { recursive: true });
  execSync('git init -q', { cwd: sub, stdio: 'pipe' });
  execSync('git config user.email "t@t.com" && git config user.name "T"', {
    cwd: sub,
    stdio: 'pipe',
  });
  writeFileSync(join(sub, 'file.txt'), 'v1\n');
  execSync('git add file.txt && git commit -qm v1', { cwd: sub, stdio: 'pipe' });

  const project = join(root, 'superproject');
  mkdirSync(project, { recursive: true });
  execSync('git init -q', { cwd: project, stdio: 'pipe' });
  execSync('git config user.email "t@t.com" && git config user.name "T"', {
    cwd: project,
    stdio: 'pipe',
  });
  writeFileSync(join(project, 'top.txt'), 'top\n');
  execSync('git add top.txt && git commit -qm top', { cwd: project, stdio: 'pipe' });
  execSync(`git -c protocol.file.allow=always submodule add -q "${sub}" sub`, {
    cwd: project,
    stdio: 'pipe',
  });
  execSync('git commit -qm "add sub"', { cwd: project, stdio: 'pipe' });
  return { project, submodule: sub };
}

function moveSubmoduleHead(project: string): void {
  writeFileSync(join(project, 'sub', 'file.txt'), 'v2\n');
  execSync('git add file.txt && git commit -qm v2', { cwd: join(project, 'sub'), stdio: 'pipe' });
}

describe('submodule (gitlink) handling', () => {
  itUnix('records a changed gitlink without capturing its content', async () => {
    const root = createTempDir('snapshot-gitlink');
    try {
      const { project } = createSuperprojectWithSubmodule(root);
      moveSubmoduleHead(project);

      const snapshot = await getChangedFilesSnapshot(project);

      expect(snapshot.files).toContain('sub');
      expect(snapshot.gitlinks).toContain('sub');
      expect(Object.keys(snapshot.dirtyFileContents)).not.toContain('sub');
    } finally {
      cleanupTempDir(root);
    }
  });

  itUnix('restores a rejected gitlink by resetting the submodule working tree', async () => {
    const root = createTempDir('snapshot-gitlink-restore');
    try {
      const { project } = createSuperprojectWithSubmodule(root);
      moveSubmoduleHead(project);

      const snapshot = await getChangedFilesSnapshot(project);
      const result = await restoreDirtyFilesFromSnapshot(project, snapshot, ['sub']);

      expect(result.restoredFiles).toEqual(['sub']);
      expect(result.conflictedFiles).toEqual([]);
      expect(readFileSync(join(project, 'sub', 'file.txt'), 'utf-8')).toBe('v1\n');
      expect(execSync('git status --porcelain', { cwd: project, encoding: 'utf-8' }).trim()).toBe(
        '',
      );
    } finally {
      cleanupTempDir(root);
    }
  });
});

describe('restoreDirtyFilesFromSnapshot', () => {
  it('restores a rejected dirty file to its captured content and reports it as restored', async () => {
    const dir = createTempDir('snapshot-restore-success');
    createTestGitRepo(dir);
    try {
      // A tracked file is dirtied; the snapshot captures that pre-rejection content.
      writeFileSync(join(dir, 'init.txt'), 'DIRTY_TASK_OUTPUT');
      const snapshot = await getChangedFilesSnapshot(dir);

      // A later rejected change overwrites the file on disk.
      writeFileSync(join(dir, 'init.txt'), 'REJECTED_OVERWRITE');

      const result = await restoreDirtyFilesFromSnapshot(dir, snapshot, ['init.txt']);

      // The file on disk is back to the captured content and the result is accurate.
      expect(readFileSync(join(dir, 'init.txt'), 'utf-8')).toBe('DIRTY_TASK_OUTPUT');
      expect(result.restoredFiles).toEqual(['init.txt']);
      expect(result.conflictedFiles).toEqual([]);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('restores a file committed inside the task window to the snapshot base', async () => {
    const dir = createTempDir('snapshot-restore-committed');
    createTestGitRepo(dir, { 'feature.ts': 'export const base = 1;\n' });
    try {
      // Snapshot is taken with a clean worktree: feature.ts carries no dirty content.
      const snapshot = await getChangedFilesSnapshot(dir);

      // The task changes the file and commits it, so the worktree matches HEAD and a
      // plain discard would silently leave the committed change in place.
      writeFileSync(join(dir, 'feature.ts'), 'export const committed = 2;\n');
      execSync('git commit -am task-commit', { cwd: dir, stdio: 'pipe' });

      const result = await restoreDirtyFilesFromSnapshot(dir, snapshot, ['feature.ts']);

      // The rejection is effective: content is back to the snapshot base, not the commit.
      expect(readFileSync(join(dir, 'feature.ts'), 'utf-8')).toBe('export const base = 1;\n');
      expect(result.restoredFiles).toEqual(['feature.ts']);
      expect(result.conflictedFiles).toEqual([]);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('removes files of a plain untracked directory created during the task on rejection', async () => {
    const dir = createTempDir('snapshot-restore-untracked-dir');
    createTestGitRepo(dir);
    try {
      // The directory is absent at snapshot time.
      const snapshot = await getChangedFilesSnapshot(dir);

      // The task creates a multi-file untracked directory that porcelain collapses.
      mkdirSync(join(dir, 'newdir', 'sub'), { recursive: true });
      writeFileSync(join(dir, 'newdir', 'a.ts'), 'export const a = 1;');
      writeFileSync(join(dir, 'newdir', 'sub', 'b.ts'), 'export const b = 2;');

      // The change universe must surface each created file, not the collapsed dir.
      const changed = await getChangedFilesSinceSnapshot(dir, snapshot);
      expect(changed).toContain('newdir/a.ts');
      expect(changed).toContain('newdir/sub/b.ts');

      const result = await restoreDirtyFilesFromSnapshot(dir, snapshot, changed);

      // Rejection removes every file the task created under the new directory.
      expect(existsSync(join(dir, 'newdir', 'a.ts'))).toBe(false);
      expect(existsSync(join(dir, 'newdir', 'sub', 'b.ts'))).toBe(false);
      expect(result.restoredFiles).toEqual(
        expect.arrayContaining(['newdir/a.ts', 'newdir/sub/b.ts']),
      );
      expect(result.conflictedFiles).toEqual([]);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('removes a file that only exists via a commit inside the task window', async () => {
    const dir = createTempDir('snapshot-restore-committed-new');
    createTestGitRepo(dir);
    try {
      // The file is absent at snapshot time.
      const snapshot = await getChangedFilesSnapshot(dir);

      // The task creates and commits a brand-new file.
      writeFileSync(join(dir, 'added.ts'), 'export const added = true;\n');
      execSync('git add added.ts && git commit -m add', { cwd: dir, stdio: 'pipe' });

      const result = await restoreDirtyFilesFromSnapshot(dir, snapshot, ['added.ts']);

      // Restoring to the base removes the committed file entirely.
      expect(existsSync(join(dir, 'added.ts'))).toBe(false);
      expect(result.restoredFiles).toEqual(['added.ts']);
      expect(result.conflictedFiles).toEqual([]);
      // Restore is faithful to the base where the path was never indexed: the
      // index entry is gone too, not left as a phantom staged deletion.
      expect(execSync('git ls-files -- added.ts', { cwd: dir, encoding: 'utf-8' }).trim()).toBe('');
    } finally {
      cleanupTempDir(dir);
    }
  });

  itUnix('propagates a confinement escape when restoring a committed-leg file', async () => {
    const dir = createTempDir('snapshot-restore-committed-escape');
    const outside = createTempDir('snapshot-restore-committed-outside');
    createTestGitRepo(dir);
    try {
      // The file is absent at snapshot time, committed inside the window, so the
      // committed-leg path drives the restore through writeCurrentFileContent(null).
      const snapshot = await getChangedFilesSnapshot(dir);
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(dir, 'src', 'added.ts'), 'export const added = true;\n');
      execSync('git add src/added.ts && git commit -m add', { cwd: dir, stdio: 'pipe' });

      // The path is replaced by a symlink escaping the root before restore runs.
      writeFileSync(join(outside, 'victim.txt'), 'must-not-delete');
      rmSync(join(dir, 'src', 'added.ts'));
      symlinkSync(join(outside, 'victim.txt'), join(dir, 'src', 'added.ts'));

      // A confinement escape is a non-recoverable boundary violation: it must
      // propagate as a hard failure, not be downgraded to an ordinary conflict.
      await expect(restoreDirtyFilesFromSnapshot(dir, snapshot, ['src/added.ts'])).rejects.toThrow(
        /unsafe path/,
      );
      expect(existsSync(join(outside, 'victim.txt'))).toBe(true);
    } finally {
      cleanupTempDir(outside);
      cleanupTempDir(dir);
    }
  });
});

describe('restore confined deletes', () => {
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
      expect(readFileSync(join(outside, 'victim.txt'), 'utf8')).toBe('must-not-delete');
    } finally {
      cleanupTempDir(outside);
      cleanupTempDir(dir);
    }
  });
});
