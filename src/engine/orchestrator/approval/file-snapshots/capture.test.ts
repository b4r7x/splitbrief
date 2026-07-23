import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { uniqueProjectFiles } from './types.js';
import { getChangedFilesSinceSnapshot, getChangedFilesSnapshot } from './capture.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';

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
