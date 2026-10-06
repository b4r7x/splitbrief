import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  UNREADABLE_FINGERPRINT,
  captureChangedFilesBaseline,
  inferTaskAcceptedChangedFiles,
  changedFilesSinceBaseline,
  deserializeChangedFilesBaseline,
  refreshChangedFilesBaseline,
  serializeChangedFilesBaseline,
  unreadableChangedFiles,
  userVisibleChangedFiles,
  withActiveTaskSnapshot,
} from './changed-files-baseline.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { makeTask } from '#testing/helpers/factories/task.js';

const itUnix = process.platform === 'win32' ? it.skip : it;

// Git is an injected read-only boundary. History lives only in this test's Map;
// the real filesystem remains responsible for bytes, links, and permissions.
const history = new Map<string, Array<Record<string, string>>>();
afterEach(() => history.clear());

function contents(dir: string, prefix = ''): Record<string, string> {
  const result: Record<string, string> = {};
  for (const entry of readdirSync(join(dir, prefix), { withFileTypes: true })) {
    const file = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) Object.assign(result, contents(dir, file));
    else result[file] = entry.isSymbolicLink() ? 'symlink' : readFileSync(join(dir, file), 'utf8');
  }
  return result;
}
function changed(a: Record<string, string>, b: Record<string, string>): string[] {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((file) => a[file] !== b[file]);
}
function recordHead(dir: string): void {
  mkdirSync(join(dir, '.git'), { recursive: true });
  const revisions = history.get(dir) ?? [];
  revisions.push(contents(dir));
  history.set(dir, revisions);
}
function seedProject(dir: string): void {
  writeFileSync(join(dir, 'init.txt'), 'init');
  recordHead(dir);
}
vi.mock('../../lib/git/files.js', () => ({
  getCurrentChangedFiles: async (dir: string) =>
    changed(history.get(dir)?.at(-1) ?? {}, contents(dir)),
}));
vi.mock('../../lib/git/repository.js', () => ({
  hasCommits: async (dir: string) => (history.get(dir)?.length ?? 0) > 0,
}));
vi.mock('../../lib/git/refs.js', () => ({
  getCurrentCommitSha: async (dir: string) => String((history.get(dir)?.length ?? 0) - 1),
  resolveRunStartBase: async ({ head }: { head: string | null }) => ({
    kind: 'commit',
    ref: head ?? '-1',
  }),
}));
vi.mock('../../lib/git/diff.js', () => ({
  getCommittedFilesSince: async (dir: string, ref: string) =>
    changed(history.get(dir)?.[Number(ref)] ?? {}, history.get(dir)?.at(-1) ?? {}),
}));

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
    seedProject(dir);
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

  itUnix.each([
    {
      label: 'by its target when it stays inside the project',
      target: 'missing.ts',
      fingerprint: 'symlink:missing.ts',
    },
    {
      label: 'as unreadable when it leaves the project',
      target: '../../missing.ts',
      fingerprint: UNREADABLE_FINGERPRINT,
    },
  ])(
    'records a dangling final symlink $label, never as missing',
    async ({ target, fingerprint }) => {
      const dir = createTempDir('changed-files-baseline-dangling-symlink');
      seedProject(dir);
      try {
        mkdirSync(join(dir, 'src'), { recursive: true });
        symlinkSync(target, join(dir, 'src', 'dangling.ts'));

        const baseline = await captureChangedFilesBaseline(dir, ['src/dangling.ts']);

        expect(baseline.fingerprints.get('src/dangling.ts')).toBe(fingerprint);
        expect(baseline.fingerprints.get('src/dangling.ts')).not.toBe('missing');
      } finally {
        cleanupTempDir(dir);
      }
    },
  );

  // A skill link like `.claude/skills/<name> -> ../../skills/<name>` sits in the
  // checkout of every run; it is read by its target, not warned about at run start.
  itUnix(
    'records a symlink that stays inside the project by its target, not as unreadable',
    async () => {
      const dir = createTempDir('changed-files-baseline-project-link');
      seedProject(dir);
      try {
        mkdirSync(join(dir, 'skills', 'babysit'), { recursive: true });
        mkdirSync(join(dir, 'skills', 'other'), { recursive: true });
        mkdirSync(join(dir, '.claude', 'skills'), { recursive: true });
        const link = join(dir, '.claude', 'skills', 'babysit');
        symlinkSync('../../skills/babysit', link, 'dir');

        const baseline = await captureChangedFilesBaseline(dir, ['.claude/skills/babysit']);

        expect(baseline.fingerprints.get('.claude/skills/babysit')).toBe(
          'symlink:../../skills/babysit',
        );
        expect(unreadableChangedFiles(baseline)).toEqual([]);
        expect(await changedFilesSinceBaseline(dir, baseline)).toEqual([]);

        unlinkSync(link);
        symlinkSync('../../skills/other', link, 'dir');
        expect(await changedFilesSinceBaseline(dir, baseline)).toEqual(['.claude/skills/babysit']);
      } finally {
        cleanupTempDir(dir);
      }
    },
  );

  itUnix(
    'records a link to the project root by its target and a link into .git as unreadable',
    async () => {
      const dir = createTempDir('changed-files-baseline-root-link');
      seedProject(dir);
      try {
        mkdirSync(join(dir, '.git'), { recursive: true });
        symlinkSync('.', join(dir, 'root-link'));
        symlinkSync('.git', join(dir, 'git-link'));

        const baseline = await captureChangedFilesBaseline(dir, ['git-link', 'root-link']);

        expect(baseline.fingerprints.get('root-link')).toBe('symlink:.');
        expect(unreadableChangedFiles(baseline)).toEqual(['git-link']);
      } finally {
        cleanupTempDir(dir);
      }
    },
  );

  it('rejects absolute changed-file paths', async () => {
    const dir = createTempDir('changed-files-baseline-absolute');
    seedProject(dir);
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
    seedProject(dir);
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
      seedProject(dir);
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
    seedProject(dir);
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
    seedProject(dir);
    try {
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(dir, 'src', 'swap.ts'), 'original\n');
      recordHead(dir);
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
    seedProject(dir);
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
    seedProject(dir);
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
    seedProject(dir);
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
    seedProject(dir);
    try {
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(dir, 'src', 'a.ts'), 'original\n');
      recordHead(dir);

      const baseline = await captureChangedFilesBaseline(dir);
      expect(await changedFilesSinceBaseline(dir, baseline)).toEqual([]);

      // A user edit lands and is then committed (mirrors a per-task commit that
      // sweeps the edit into history, leaving the working tree clean).
      writeFileSync(join(dir, 'src', 'a.ts'), 'user edit\n');
      recordHead(dir);

      expect(await changedFilesSinceBaseline(dir, baseline)).toEqual(['src/a.ts']);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('includes a first commit made after an unborn run start', async () => {
    const dir = createTempDir('changed-files-baseline-unborn');
    try {
      mkdirSync(join(dir, '.git'));
      const baseline = await captureChangedFilesBaseline(dir);
      expect(baseline.head).toBeNull();

      writeFileSync(join(dir, 'first.ts'), 'export const first = true;\n');
      recordHead(dir);

      expect(await changedFilesSinceBaseline(dir, baseline)).toEqual(['first.ts']);
    } finally {
      cleanupTempDir(dir);
    }
  });
});

describe('changedFilesSinceBaseline artifact-name neutrality', () => {
  it('matches an artifact basename nested under a subdirectory, not only at the root', async () => {
    const dir = createTempDir('changed-files-baseline-artifact-tasks');
    seedProject(dir);
    try {
      const baseline = await captureChangedFilesBaseline(dir);

      mkdirSync(join(dir, 'docs'), { recursive: true });
      writeFileSync(join(dir, 'docs/tasks.md'), '---\nid: task-1\n---\n# Do the thing\n');

      expect(await changedFilesSinceBaseline(dir, baseline)).toEqual(['docs/tasks.md']);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('reports direct writes of every planner artifact basename', async () => {
    const dir = createTempDir('changed-files-baseline-artifact-all');
    seedProject(dir);
    try {
      const baseline = await captureChangedFilesBaseline(dir);

      for (const name of ['research.md', 'spec.md', 'plan.md', 'tasks.md']) {
        writeFileSync(join(dir, name), `# ${name}\n`);
      }

      expect(await changedFilesSinceBaseline(dir, baseline)).toEqual([
        'plan.md',
        'research.md',
        'spec.md',
        'tasks.md',
      ]);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('captures a pre-existing tasks.md without admitting later edits', async () => {
    const dir = createTempDir('changed-files-baseline-artifact-pre-existing');
    seedProject(dir);
    try {
      writeFileSync(join(dir, 'tasks.md'), '---\nid: task-1\n---\n# Original\n');
      const baseline = await captureChangedFilesBaseline(dir);

      expect(await changedFilesSinceBaseline(dir, baseline)).toEqual([]);

      writeFileSync(join(dir, 'tasks.md'), '---\nid: task-2\n---\n# Edited\n');

      expect(await changedFilesSinceBaseline(dir, baseline)).toEqual(['tasks.md']);
    } finally {
      cleanupTempDir(dir);
    }
  });
});

describe('changed-files rolling disappearance', () => {
  it('reports a tracked dirty file becoming clean', async () => {
    const dir = createTempDir('changed-files-baseline-tracked-clean');
    seedProject(dir);
    try {
      writeFileSync(join(dir, 'tracked.txt'), 'original\n');
      recordHead(dir);
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
    seedProject(dir);
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
    seedProject(dir);
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
    seedProject(dir);
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
    seedProject(dir);
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
    seedProject(dir);
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

describe('inferTaskAcceptedChangedFiles', () => {
  it('attributes every declared file and a prose in-bounds bullet', async () => {
    const dir = createTempDir('infer-task-accepted-declared-set');
    seedProject(dir);
    try {
      mkdirSync(join(dir, 'src'), { recursive: true });
      for (const file of ['a.ts', 'a.test.ts', 'x.ts', 'leak.ts']) {
        writeFileSync(join(dir, 'src', file), 'export const changed = true;\n');
      }
      const task = makeTask({
        suggestedFiles: ['src/a.ts', 'src/a.test.ts'],
        scope: { inBounds: ['`src/x.ts` \u2014 the union collapse'] },
      });

      const attributed = await inferTaskAcceptedChangedFiles(dir, task, null);

      expect(attributed.sort()).toEqual(['src/a.test.ts', 'src/a.ts', 'src/x.ts']);
    } finally {
      cleanupTempDir(dir);
    }
  });
});
