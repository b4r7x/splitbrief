import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  uniqueProjectFiles,
  getChangedFilesSinceSnapshot,
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

  it('filters out worktree files nested under any directory level', () => {
    expect(
      uniqueProjectFiles(['src/a.ts', '.trees/feat/src/b.ts', 'sub/.trees/feat/c.ts']),
    ).toEqual(['src/a.ts']);
  });

  it('filters out empty strings', () => {
    expect(uniqueProjectFiles(['a.ts', '', 'b.ts'])).toEqual(['a.ts', 'b.ts']);
  });

  it('treats porcelain directory entries as opaque', () => {
    expect(uniqueProjectFiles(['src/a.ts', 'vendored/', 'nested/repo/'])).toEqual(['src/a.ts']);
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

  it('falls back to the empty-tree hash in a zero-commit repository', async () => {
    const dir = createTempDir('snapshot-unborn');
    execSync('git init', { cwd: dir, stdio: 'pipe' });
    writeFileSync(join(dir, 'pending.ts'), 'export const x = 1;');

    const snapshot = await getChangedFilesSnapshot(dir);

    expect(snapshot.head).toBe('4b825dc642cb6eb9a060e54bf8d69288fbee4904');
    expect(snapshot.files).toContain('pending.ts');
    cleanupTempDir(dir);
  });

  it('omits a present .trees worktree directory from the change snapshot', async () => {
    const dir = createTempDir('snapshot-worktree');
    createTestGitRepo(dir);
    execSync('git worktree add .trees/feat -b feat', { cwd: dir, stdio: 'pipe' });
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'app.ts'), 'export const app = true;');

    const embedded: string[] = [];
    const snapshot = await getChangedFilesSnapshot(dir, (d) => embedded.push(d));

    expect(snapshot.files).toContain('src/app.ts');
    expect(snapshot.files.some((file) => file.startsWith('.trees'))).toBe(false);
    expect(embedded.some((d) => d.startsWith('.trees'))).toBe(false);
    cleanupTempDir(dir);
  });

  it('does not capture content for an embedded untracked git repository', async () => {
    const dir = createTempDir('snapshot-embedded');
    createTestGitRepo(dir);
    const embedded = join(dir, 'vendored');
    mkdirSync(embedded, { recursive: true });
    execSync('git init', { cwd: embedded, stdio: 'pipe' });
    execSync('git config user.email "t@t.com" && git config user.name "T"', {
      cwd: embedded,
      stdio: 'pipe',
    });
    writeFileSync(join(embedded, 'inner.txt'), 'inner');
    execSync('git add inner.txt && git commit -m inner', { cwd: embedded, stdio: 'pipe' });

    const snapshot = await getChangedFilesSnapshot(dir);

    expect(snapshot.files).not.toContain('vendored/');
    expect(Object.keys(snapshot.dirtyFileContents)).not.toContain('vendored/');
    cleanupTempDir(dir);
  });

  it('captures the files of a plain untracked directory without reporting it as embedded', async () => {
    const dir = createTempDir('snapshot-untracked-dir');
    createTestGitRepo(dir);
    mkdirSync(join(dir, 'newdir', 'sub'), { recursive: true });
    writeFileSync(join(dir, 'newdir', 'a.ts'), 'export const a = 1;');
    writeFileSync(join(dir, 'newdir', 'sub', 'b.ts'), 'export const b = 2;');

    const ignored: string[] = [];
    const snapshot = await getChangedFilesSnapshot(dir, (d) => ignored.push(d));

    expect(snapshot.files).toContain('newdir/a.ts');
    expect(snapshot.files).toContain('newdir/sub/b.ts');
    expect(snapshot.files).not.toContain('newdir/');
    expect(snapshot.dirtyFileContents['newdir/a.ts']).toBe('export const a = 1;');
    expect(snapshot.dirtyFileContents['newdir/sub/b.ts']).toBe('export const b = 2;');
    expect(ignored).not.toContain('newdir/');
    cleanupTempDir(dir);
  });

  it('reports each embedded untracked git repository it skips', async () => {
    const dir = createTempDir('snapshot-embedded-warn');
    createTestGitRepo(dir);
    const embedded = join(dir, 'vendored');
    mkdirSync(embedded, { recursive: true });
    execSync('git init', { cwd: embedded, stdio: 'pipe' });
    execSync('git config user.email "t@t.com" && git config user.name "T"', {
      cwd: embedded,
      stdio: 'pipe',
    });
    writeFileSync(join(embedded, 'inner.txt'), 'inner');
    execSync('git add inner.txt && git commit -m inner', { cwd: embedded, stdio: 'pipe' });

    const ignored: string[] = [];
    await getChangedFilesSnapshot(dir, (d) => ignored.push(d));

    expect(ignored).toContain('vendored/');
    cleanupTempDir(dir);
  });
});

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

describe('getChangedFilesSinceSnapshot', () => {
  it('merges a working-tree edit with a file committed inside the task window on a real repo', async () => {
    const dir = createTempDir('snapshot-merge-committed');
    createTestGitRepo(dir, {
      'committed.ts': 'export const base = 1;\n',
      'edited.ts': 'export const edited = 1;\n',
    });
    try {
      // Snapshot is taken with a clean worktree against a real .git repo, so the
      // status leg starts empty and the committed leg is anchored at this HEAD.
      const snapshot = await getChangedFilesSnapshot(dir);

      // The committed leg: a file is changed and committed inside the window, so it
      // no longer appears in status and is only visible via getCommittedFilesSince.
      writeFileSync(join(dir, 'committed.ts'), 'export const base = 2;\n');
      execSync('git commit -am task-commit', { cwd: dir, stdio: 'pipe' });

      // The status leg: a separate file is dirtied in the working tree.
      writeFileSync(join(dir, 'edited.ts'), 'export const edited = 2;\n');

      const changed = await getChangedFilesSinceSnapshot(dir, snapshot);

      expect(changed).toEqual(['committed.ts', 'edited.ts']);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('returns working-tree changes without throwing when the repo is still unborn at query time', async () => {
    const dir = createTempDir('snapshot-unborn-query');
    execSync('git init', { cwd: dir, stdio: 'pipe' });
    writeFileSync(join(dir, 'pending.ts'), 'export const x = 1;');
    try {
      const snapshot = await getChangedFilesSnapshot(dir);

      // A second file is added while the repo still has zero commits.
      writeFileSync(join(dir, 'added.ts'), 'export const y = 2;');

      const changed = await getChangedFilesSinceSnapshot(dir, snapshot);

      expect(changed).toContain('added.ts');
    } finally {
      cleanupTempDir(dir);
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
