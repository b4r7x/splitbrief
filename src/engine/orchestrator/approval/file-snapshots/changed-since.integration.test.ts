import { afterEach, describe, it, expect, vi } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ChangedFilesSnapshot } from '../../../../core/schemas/workflow/changed-files.js';
import { getChangedFilesSnapshot } from './capture.js';
import { getChangedFilesSinceSnapshot } from './changed-since.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { capturedText } from '#testing/helpers/captured-text.js';

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

  it('leaves out a node_modules link at the root that only a directory pattern ignores', async () => {
    const dir = createTempDir('snapshot-node-modules-link');
    const deps = createTempDir('snapshot-node-modules-deps');
    try {
      createTestGitRepo(dir, {
        '.gitignore': 'node_modules/\n',
        'src/a.ts': 'export const a = 1;\n',
      });
      const snapshot = await getChangedFilesSnapshot(dir);

      symlinkSync(deps, join(dir, 'node_modules'), 'dir');
      writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 2;\n');

      expect(execSync('git status --porcelain', { cwd: dir, encoding: 'utf8' })).toContain(
        '?? node_modules',
      );
      expect(await getChangedFilesSinceSnapshot(dir, snapshot)).toEqual(['src/a.ts']);
    } finally {
      cleanupTempDir(dir);
      cleanupTempDir(deps);
    }
  });

  it('still lists a changed tracked file under node_modules', async () => {
    const dir = createTempDir('snapshot-node-modules-tracked');
    try {
      createTestGitRepo(dir, {
        '.gitignore': 'node_modules/\n',
        'node_modules/pkg/index.js': 'export const pkg = 1;\n',
        'src/a.ts': 'export const a = 1;\n',
      });
      const snapshot = await getChangedFilesSnapshot(dir);

      writeFileSync(join(dir, 'node_modules', 'pkg', 'index.js'), 'export const pkg = 2;\n');

      expect(await getChangedFilesSinceSnapshot(dir, snapshot)).toEqual([
        'node_modules/pkg/index.js',
      ]);
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
