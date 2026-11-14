import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { uniqueProjectFiles } from './types.js';
import { getChangedFilesSnapshot } from './capture.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo, recordGitLaunches } from '#testing/helpers/git.js';
import { capturedText } from '#testing/helpers/captured-text.js';

describe('uniqueProjectFiles', () => {
  it('removes duplicates and sorts', () => {
    expect(uniqueProjectFiles(['b.ts', 'a.ts', 'b.ts'])).toEqual(['a.ts', 'b.ts']);
  });

  it('filters out splitbrief dir files', () => {
    expect(uniqueProjectFiles(['src/a.ts', '.splitbrief/config.json'])).toEqual(['src/a.ts']);
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

  it('reads HEAD with one git launch', async () => {
    const dir = createTempDir('snapshot-head-launch');
    createTestGitRepo(dir);
    const head = execSync('git rev-parse HEAD', { cwd: dir }).toString().trim();
    const launches = recordGitLaunches();
    try {
      const snapshot = await getChangedFilesSnapshot(dir);
      expect(snapshot.head).toBe(head);
      expect(launches.launches().filter((args) => args.startsWith('rev-parse'))).toEqual([
        'rev-parse --verify HEAD',
      ]);
    } finally {
      launches.restore();
      cleanupTempDir(dir);
    }
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
    expect(capturedText(snapshot, 'newdir/a.ts')).toBe('export const a = 1;');
    expect(capturedText(snapshot, 'newdir/sub/b.ts')).toBe('export const b = 2;');
    expect(snapshot.dirtyFileContents).toEqual({});
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

  it('records an untracked symlink that stays inside the project by its target', async () => {
    const dir = createTempDir('snapshot-project-link');
    try {
      createTestGitRepo(dir, { 'skills/babysit/SKILL.md': '# babysit\n' });
      mkdirSync(join(dir, '.claude', 'skills'), { recursive: true });
      symlinkSync('../../skills/babysit', join(dir, '.claude', 'skills', 'babysit'), 'dir');

      const snapshot = await getChangedFilesSnapshot(dir);

      expect(snapshot.files).toEqual(['.claude/skills/babysit']);
      expect(snapshot.symlinks).toEqual({ '.claude/skills/babysit': '../../skills/babysit' });
      expect(snapshot.dirtyFileEntries).toEqual({});
    } finally {
      cleanupTempDir(dir);
    }
  });

  it.each([
    { label: 'an absolute symlink', target: (dir: string) => join(dir, 'skills') },
    { label: 'a relative symlink that leaves the project', target: () => '../outside' },
  ])('still refuses $label in the changed set', async ({ target }) => {
    const dir = createTempDir('snapshot-refused-link');
    try {
      createTestGitRepo(dir, { 'skills/babysit/SKILL.md': '# babysit\n' });
      symlinkSync(target(dir), join(dir, 'linked'), 'dir');

      await expect(getChangedFilesSnapshot(dir)).rejects.toThrow(
        /refusing to read through symlink/,
      );
    } finally {
      cleanupTempDir(dir);
    }
  });
});
