import { afterEach, describe, it, expect, vi } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ChangedFilesSnapshot } from '../../../../core/schemas/workflow.js';
import { uniqueProjectFiles } from './types.js';
import { getChangedFilesSinceSnapshot, getChangedFilesSnapshot } from './capture.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo, recordGitLaunches } from '#testing/helpers/git.js';

// The Git legs are stubbed per test so a working tree can be described without a
// repository; every unset field falls through to the real implementation, which
// the real-repo suites above and below still exercise.
const git = vi.hoisted(() => ({
  status: null as string[] | null,
  hasCommits: null as boolean | null,
  committedSince: null as string[] | null,
}));

vi.mock('../../../../lib/git/files.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../lib/git/files.js')>();
  return {
    ...actual,
    getCurrentChangedFiles: async (dir: string) => git.status ?? actual.getCurrentChangedFiles(dir),
  };
});

vi.mock('../../../../lib/git/repository.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../lib/git/repository.js')>();
  return {
    ...actual,
    hasCommits: async (dir: string) => git.hasCommits ?? actual.hasCommits(dir),
    readHeadSha: async (dir: string) =>
      git.hasCommits === null ? actual.readHeadSha(dir) : git.hasCommits ? 'stub-head' : null,
  };
});

vi.mock('../../../../lib/git/diff.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../lib/git/diff.js')>();
  return {
    ...actual,
    getCommittedFilesSince: async (dir: string, since: string) =>
      git.committedSince ?? actual.getCommittedFilesSince(dir, since),
  };
});

// Fresh captures carry exact bytes and modes in dirtyFileEntries; the legacy
// text field dirtyFileContents stays empty and only loads old snapshots.
function capturedText(snapshot: ChangedFilesSnapshot, file: string): string | undefined {
  const entry = snapshot.dirtyFileEntries?.[file];
  return entry === undefined || entry === null
    ? undefined
    : Buffer.from(entry.base64, 'base64').toString('utf-8');
}

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

  it('reports a recorded project symlink only once it no longer holds its target', async () => {
    const dir = createTempDir('snapshot-project-link-since');
    try {
      createTestGitRepo(dir, {
        'skills/babysit/SKILL.md': '# babysit\n',
        'skills/other/SKILL.md': '# other\n',
      });
      mkdirSync(join(dir, '.claude', 'skills'), { recursive: true });
      const link = join(dir, '.claude', 'skills', 'babysit');
      symlinkSync('../../skills/babysit', link, 'dir');
      const snapshot = await getChangedFilesSnapshot(dir);

      expect(await getChangedFilesSinceSnapshot(dir, snapshot)).toEqual([]);

      rmSync(link);
      symlinkSync('../../skills/other', link, 'dir');
      expect(await getChangedFilesSinceSnapshot(dir, snapshot)).toEqual(['.claude/skills/babysit']);

      rmSync(link);
      expect(await getChangedFilesSinceSnapshot(dir, snapshot)).toEqual(['.claude/skills/babysit']);
    } finally {
      cleanupTempDir(dir);
    }
  });
});

describe('getChangedFilesSinceSnapshot — baseline files that leave git status', () => {
  let dirs: string[] = [];

  afterEach(() => {
    git.status = null;
    git.hasCommits = null;
    git.committedSince = null;
    for (const dir of dirs) cleanupTempDir(dir);
    dirs = [];
  });

  async function acquire(
    name: string,
    files: Record<string, string>,
  ): Promise<{ dir: string; snapshot: ChangedFilesSnapshot }> {
    const dir = createTempDir(name);
    dirs.push(dir);
    for (const [file, content] of Object.entries(files)) {
      mkdirSync(join(dir, dirname(file)), { recursive: true });
      writeFileSync(join(dir, file), content);
    }
    // Acquisition: git reports every one of these as dirty in the working tree.
    git.status = Object.keys(files);
    git.hasCommits = false;
    const snapshot = await getChangedFilesSnapshot(dir);
    return { dir, snapshot };
  }

  it('reports an untracked acquisition file the worker deleted', async () => {
    const { dir, snapshot } = await acquire('snapshot-untracked-delete', {
      'src/gone.ts': 'export const gone = 1;\n',
      'src/keep.ts': 'export const keep = 1;\n',
    });
    expect(capturedText(snapshot, 'src/gone.ts')).toBe('export const gone = 1;\n');

    // The worker deletes it. It was never tracked, so git status simply stops
    // mentioning it and only the acquisition baseline still knows it existed.
    rmSync(join(dir, 'src', 'gone.ts'));
    git.status = ['src/keep.ts'];

    expect(await getChangedFilesSinceSnapshot(dir, snapshot)).toEqual(['src/gone.ts']);
  });

  it('reports a deletion and a modification together', async () => {
    const { dir, snapshot } = await acquire('snapshot-untracked-mixed', {
      'src/gone.ts': 'export const gone = 1;\n',
      'src/keep.ts': 'export const keep = 1;\n',
    });

    rmSync(join(dir, 'src', 'gone.ts'));
    writeFileSync(join(dir, 'src', 'keep.ts'), 'export const keep = 2;\n');
    git.status = ['src/keep.ts'];

    expect(await getChangedFilesSinceSnapshot(dir, snapshot)).toEqual([
      'src/gone.ts',
      'src/keep.ts',
    ]);
  });

  it('reports a dirty baseline file the worker restored to HEAD', async () => {
    const { dir, snapshot } = await acquire('snapshot-restored-to-head', {
      'src/app.ts': 'export const app = "dirty";\n',
    });

    // Back to the committed bytes: the file is clean again, so it leaves status,
    // but it is not what the acquisition baseline held.
    writeFileSync(join(dir, 'src', 'app.ts'), 'export const app = "head";\n');
    git.status = [];
    git.hasCommits = true;
    git.committedSince = [];

    expect(await getChangedFilesSinceSnapshot(dir, snapshot)).toEqual(['src/app.ts']);
  });

  it('reports a dirty baseline file the worker replaced with a symlink', async () => {
    const { dir, snapshot } = await acquire('snapshot-dirty-to-link', {
      'src/app.ts': 'export const app = "dirty";\n',
      'src/real.ts': 'export const real = 1;\n',
    });

    rmSync(join(dir, 'src', 'app.ts'));
    symlinkSync('real.ts', join(dir, 'src', 'app.ts'));
    git.status = ['src/app.ts', 'src/real.ts'];

    expect(await getChangedFilesSinceSnapshot(dir, snapshot)).toEqual(['src/app.ts']);
  });

  it('leaves an untouched dirty baseline file out of the result', async () => {
    const { dir, snapshot } = await acquire('snapshot-untouched-dirty', {
      'src/app.ts': 'export const app = "dirty";\n',
    });

    git.status = ['src/app.ts'];

    expect(await getChangedFilesSinceSnapshot(dir, snapshot)).toEqual([]);
  });
});
