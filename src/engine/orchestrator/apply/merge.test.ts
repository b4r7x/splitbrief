import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { delimiter, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  SNAPSHOT_BASELINE_ID,
  snapshotFilesDir,
  snapshotManifestPath,
} from '../../../core/paths.js';
import { type ApplyRun, withApplyRun } from '#testing/helpers/apply-run.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import { readManifest } from '../../snapshots/manifest.js';
import { mergeApplyStates } from './merge.js';
import { captureApplyStates } from './states.js';

const SESSION_ID = '2026-10-04-apply-merge-test';
const itUnix = process.platform === 'win32' ? it.skip : it;

const lines = (...values: string[]): string => `${values.join('\n')}\n`;
const FIVE = lines('one', 'two', 'three', 'four', 'five');

type Run = ApplyRun;

async function withRun(
  files: Record<string, string>,
  body: (run: Run) => Promise<void>,
  atBase?: (dir: string) => void,
): Promise<void> {
  await withApplyRun(files, { sessionId: SESSION_ID, ...(atBase && { atBase }) }, body);
}

async function merge(run: Run) {
  return mergeApplyStates(
    await captureApplyStates({
      projectDir: run.dir,
      sessionId: SESSION_ID,
      workspace: run.workspace,
    }),
  );
}

const read = (root: string, file: string): string => readFileSync(join(root, file), 'utf8');
const mode = (root: string, file: string): number => statSync(join(root, file)).mode & 0o777;

describe('git-merge-three-states', { timeout: 60_000 }, () => {
  it('merges disjoint edits into the workspace and lists the file for promotion', async () => {
    await withRun({ 'a.txt': FIVE }, async (run) => {
      writeFileSync(join(run.ws, 'a.txt'), lines('ONE', 'two', 'three', 'four', 'five'));
      writeFileSync(join(run.dir, 'a.txt'), lines('one', 'two', 'three', 'four', 'FIVE'));

      const result = await merge(run);

      expect(result.conflicts).toEqual([]);
      expect(result.promote).toEqual(['a.txt']);
      expect(read(run.ws, 'a.txt')).toBe(lines('ONE', 'two', 'three', 'four', 'FIVE'));
      expect(read(run.dir, 'a.txt')).toBe(lines('one', 'two', 'three', 'four', 'FIVE'));
    });
  });

  it('returns a text conflict with git markers and leaves the workspace bytes alone', async () => {
    await withRun({ 'a.txt': FIVE }, async (run) => {
      const ours = lines('one', 'two', 'OURS', 'four', 'five');
      writeFileSync(join(run.ws, 'a.txt'), ours);
      writeFileSync(join(run.dir, 'a.txt'), lines('one', 'two', 'THEIRS', 'four', 'five'));

      const result = await merge(run);

      expect(result.promote).toEqual([]);
      expect(result.conflicts).toHaveLength(1);
      const [conflict] = result.conflicts;
      expect(conflict).toMatchObject({
        path: 'a.txt',
        kind: 'text',
        base: { kind: 'file' },
        ours: { kind: 'file' },
        theirs: { kind: 'file' },
      });
      const markers = conflict?.markers?.toString('utf8') ?? '';
      expect(markers).toContain('<<<<<<< ours');
      expect(markers).toContain('||||||| base');
      expect(markers).toContain('>>>>>>> theirs');
      expect(read(run.ws, 'a.txt')).toBe(ours);
    });
  });

  itUnix('returns a text conflict without markers when git cannot merge text', async () => {
    await withRun({ 'a.txt': FIVE }, async (run) => {
      const ours = lines('ONE', 'two', 'three', 'four', 'five');
      writeFileSync(join(run.ws, 'a.txt'), ours);
      writeFileSync(join(run.dir, 'a.txt'), lines('one', 'two', 'three', 'four', 'FIVE'));
      const states = await captureApplyStates({
        projectDir: run.dir,
        sessionId: SESSION_ID,
        workspace: run.workspace,
      });
      const gitDir = createTempDir('apply-unmergeable-git');
      const previousPath = process.env.PATH;
      try {
        writeFileSync(join(gitDir, 'git'), '#!/bin/sh\nexit 129\n');
        chmodSync(join(gitDir, 'git'), 0o755);
        process.env.PATH = `${gitDir}${delimiter}${previousPath ?? ''}`;

        const result = await mergeApplyStates(states);

        expect(result.promote).toEqual([]);
        expect(result.conflicts).toMatchObject([{ path: 'a.txt', kind: 'text' }]);
        expect(result.conflicts).toHaveLength(1);
        expect(result.conflicts[0]?.markers).toBeUndefined();
        expect(read(run.ws, 'a.txt')).toBe(ours);
      } finally {
        if (previousPath === undefined) delete process.env.PATH;
        else process.env.PATH = previousPath;
        cleanupTempDir(gitDir);
      }
    });
  });

  it('includes checkout edits outside the run in the workspace without promoting them', async () => {
    await withRun({ 'a.txt': FIVE, 'other.txt': 'before\n', 'gone.txt': 'x\n' }, async (run) => {
      writeFileSync(join(run.ws, 'added.txt'), 'from the run\n');
      writeFileSync(join(run.dir, 'other.txt'), 'owner edit\n');
      writeFileSync(join(run.dir, 'new.txt'), 'owner file\n');
      rmSync(join(run.dir, 'gone.txt'));

      const result = await merge(run);

      expect(result.conflicts).toEqual([]);
      expect(result.promote).toEqual(['added.txt']);
      expect(read(run.ws, 'other.txt')).toBe('owner edit\n');
      expect(read(run.ws, 'new.txt')).toBe('owner file\n');
      expect(existsSync(join(run.ws, 'gone.txt'))).toBe(false);
      expect(existsSync(join(run.dir, 'added.txt'))).toBe(false);
    });
  });
});

describe('entry-kind-matrix', { timeout: 60_000 }, () => {
  it('conflicts a directory destination before applying other checkout changes', async () => {
    await withRun({ 'a.txt': 'before\n' }, async (run) => {
      mkdirSync(join(run.ws, 'z'));
      writeFileSync(join(run.dir, 'a.txt'), 'owner edit\n');
      writeFileSync(join(run.dir, 'z'), 'owner file\n');

      const result = await merge(run);

      expect(result.promote).toEqual([]);
      expect(result.conflicts).toMatchObject([
        {
          path: 'z',
          kind: 'unsupported-entry',
          ours: { kind: 'absent' },
          theirs: { kind: 'file' },
        },
      ]);
      expect(read(run.ws, 'a.txt')).toBe('owner edit\n');
      expect(statSync(join(run.ws, 'z')).isDirectory()).toBe(true);
      expect(readdirSync(join(run.ws, 'z'))).toEqual([]);
    });
  });

  itUnix.each(['file', 'symlink'] as const)(
    'conflicts a write beneath a workspace parent that is a %s',
    async (kind) => {
      await withRun({ 'a.txt': 'before\n' }, async (run) => {
        const outside = createTempDir('apply-parent-target');
        try {
          writeFileSync(join(outside, 'child.txt'), 'outside\n');
          if (kind === 'file') writeFileSync(join(run.ws, 'z'), 'workspace parent\n');
          else symlinkSync(outside, join(run.ws, 'z'));
          mkdirSync(join(run.dir, 'z'));
          writeFileSync(join(run.dir, 'z', 'child.txt'), 'owner file\n');
          writeFileSync(join(run.dir, 'a.txt'), 'owner edit\n');

          const result = await merge(run);

          expect(result.conflicts).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                path: 'z/child.txt',
                kind: 'unsupported-entry',
                ours: { kind: 'absent' },
                theirs: expect.objectContaining({ kind: 'file' }),
              }),
            ]),
          );
          expect(result.promote).not.toContain('z/child.txt');
          expect(read(run.ws, 'a.txt')).toBe('owner edit\n');
          expect(read(outside, 'child.txt')).toBe('outside\n');
          if (kind === 'file') expect(read(run.ws, 'z')).toBe('workspace parent\n');
        } finally {
          cleanupTempDir(outside);
        }
      });
    },
  );

  it('refuses a text merge of divergent binary entries', async () => {
    await withRun({ 'bin.dat': 'a\0b\n' }, async (run) => {
      writeFileSync(join(run.ws, 'bin.dat'), 'a\0ours\n');
      writeFileSync(join(run.dir, 'bin.dat'), 'a\0theirs\n');

      const result = await merge(run);

      expect(result.promote).toEqual([]);
      expect(result.conflicts).toMatchObject([{ path: 'bin.dat', kind: 'binary' }]);
      expect(result.conflicts[0]?.markers).toBeUndefined();
    });
  });

  it('conflicts a deletion against a modification on either side', async () => {
    await withRun({ 'a.txt': FIVE, 'b.txt': FIVE }, async (run) => {
      rmSync(join(run.ws, 'a.txt'));
      writeFileSync(join(run.dir, 'a.txt'), `${FIVE}theirs\n`);
      writeFileSync(join(run.ws, 'b.txt'), `${FIVE}ours\n`);
      rmSync(join(run.dir, 'b.txt'));

      const result = await merge(run);

      expect(result.promote).toEqual([]);
      expect(result.conflicts).toMatchObject([
        {
          path: 'a.txt',
          kind: 'delete-modify',
          ours: { kind: 'absent' },
          theirs: { kind: 'file' },
        },
        {
          path: 'b.txt',
          kind: 'delete-modify',
          ours: { kind: 'file' },
          theirs: { kind: 'absent' },
        },
      ]);
    });
  });

  it('lets a deletion win over an unchanged side', async () => {
    await withRun({ 'a.txt': FIVE, 'b.txt': FIVE }, async (run) => {
      rmSync(join(run.ws, 'a.txt'));
      rmSync(join(run.dir, 'b.txt'));

      const result = await merge(run);

      expect(result.conflicts).toEqual([]);
      expect(result.promote).toEqual(['a.txt']);
      expect(existsSync(join(run.ws, 'b.txt'))).toBe(false);
    });
  });

  it('conflicts distinct additions and accepts identical ones', async () => {
    await withRun({ 'a.txt': FIVE }, async (run) => {
      writeFileSync(join(run.ws, 'n.txt'), 'ours\n');
      writeFileSync(join(run.dir, 'n.txt'), 'theirs\n');
      writeFileSync(join(run.ws, 'same.txt'), 'same\n');
      writeFileSync(join(run.dir, 'same.txt'), 'same\n');

      const result = await merge(run);

      expect(result.promote).toEqual([]);
      expect(result.conflicts).toMatchObject([
        { path: 'n.txt', kind: 'add-add', base: { kind: 'absent' } },
      ]);
    });
  });

  it('treats a rename against an edit as a conflict at the old path and promotes the new path', async () => {
    await withRun({ 'a.txt': FIVE }, async (run) => {
      rmSync(join(run.ws, 'a.txt'));
      writeFileSync(join(run.ws, 'b.txt'), FIVE);
      writeFileSync(join(run.dir, 'a.txt'), lines('one', 'two', 'THEIRS', 'four', 'five'));

      const result = await merge(run);

      expect(result.promote).toEqual(['b.txt']);
      expect(result.conflicts).toMatchObject([{ path: 'a.txt', kind: 'delete-modify' }]);
    });
  });

  itUnix(
    'takes a whole side with its mode and conflicts a mode change it cannot place',
    async () => {
      await withRun(
        { 'run.sh': 'echo a\n', 'chmod.sh': 'echo b\n', 'checkout.sh': 'echo c\n' },
        async (run) => {
          writeFileSync(join(run.ws, 'run.sh'), 'echo ours\n');
          chmodSync(join(run.ws, 'run.sh'), 0o755);
          chmodSync(join(run.ws, 'chmod.sh'), 0o755);
          writeFileSync(join(run.dir, 'checkout.sh'), 'echo theirs\n');
          chmodSync(join(run.dir, 'checkout.sh'), 0o755);

          const result = await merge(run);

          expect(result.promote).toEqual(['run.sh']);
          expect(mode(run.ws, 'run.sh')).toBe(0o755);
          expect(mode(run.ws, 'checkout.sh')).toBe(0o755);
          expect(read(run.ws, 'checkout.sh')).toBe('echo theirs\n');
          expect(result.conflicts).toMatchObject([
            {
              path: 'chmod.sh',
              kind: 'mode',
              ours: { kind: 'file', mode: 0o755 },
              theirs: { kind: 'file', mode: 0o644 },
            },
          ]);
        },
      );
    },
  );

  itUnix('keeps an unchanged link and refuses a link the run creates', async () => {
    await withRun({ 'target.txt': 'target\n' }, async (run) => {
      symlinkSync('target.txt', join(run.ws, 'kept.txt'));
      symlinkSync('target.txt', join(run.dir, 'kept.txt'));
      symlinkSync('target.txt', join(run.ws, 'made.txt'));

      const result = await merge(run);

      expect(result.promote).toEqual([]);
      expect(result.conflicts).toMatchObject([
        {
          path: 'made.txt',
          kind: 'unsupported-entry',
          ours: { kind: 'symlink', target: 'target.txt' },
          theirs: { kind: 'absent' },
        },
      ]);
    });
  });

  itUnix('refuses a symlink created only in the checkout', async () => {
    await withRun({ 'target.txt': 'target\n' }, async (run) => {
      symlinkSync('target.txt', join(run.dir, 'made.txt'));

      const result = await merge(run);

      expect(result.promote).toEqual([]);
      expect(result.conflicts).toMatchObject([
        {
          path: 'made.txt',
          kind: 'unsupported-entry',
          ours: { kind: 'absent' },
          theirs: { kind: 'symlink', target: 'target.txt' },
        },
      ]);
      expect(existsSync(join(run.ws, 'made.txt'))).toBe(false);
      expect(read(run.ws, 'target.txt')).toBe('target\n');
    });
  });

  itUnix.each(['ours', 'theirs'] as const)(
    'refuses a directory replaced by a %s symlink without reading through it',
    async (side) => {
      await withRun({ 'dir/x.txt': 'base\n' }, async (run) => {
        const outside = createTempDir('apply-directory-target');
        try {
          writeFileSync(join(outside, 'x.txt'), 'outside\n');
          const root = side === 'ours' ? run.ws : run.dir;
          rmSync(join(root, 'dir'), { recursive: true });
          symlinkSync(outside, join(root, 'dir'));

          const result = await merge(run);

          expect(result.conflicts).toMatchObject([
            {
              path: 'dir',
              kind: 'unsupported-entry',
              [side]: { kind: 'symlink', target: outside },
            },
          ]);
          expect(read(outside, 'x.txt')).toBe('outside\n');
        } finally {
          cleanupTempDir(outside);
        }
      });
    },
  );

  it('ignores the bookkeeping lines isolation adds to the workspace .gitignore', async () => {
    await withRun({ '.gitignore': 'node_modules/\n' }, async (run) => {
      writeFileSync(join(run.ws, '.gitignore'), 'node_modules/\n.splitbrief/\n');

      const result = await merge(run);

      expect(result).toEqual({ promote: [], conflicts: [] });
    });
  });

  it('omits a bookkeeping-only .gitignore when the base has none', async () => {
    await withRun({ 'a.txt': FIVE }, async (run) => {
      writeFileSync(join(run.ws, '.gitignore'), '.splitbrief/\n.trees/');

      const states = await captureApplyStates({
        projectDir: run.dir,
        sessionId: SESSION_ID,
        workspace: run.workspace,
      });

      expect(states.ours.has('.gitignore')).toBe(false);
      expect(await mergeApplyStates(states)).toEqual({ promote: [], conflicts: [] });
    });
  });

  it('keeps bookkeeping lines that already belong to the base .gitignore', async () => {
    await withRun({ '.gitignore': '.splitbrief/\nnode_modules/\n' }, async (run) => {
      writeFileSync(join(run.ws, '.gitignore'), '.splitbrief/\nnode_modules/\ndist/\n');

      const result = await merge(run);

      expect(result).toEqual({ promote: ['.gitignore'], conflicts: [] });
      expect(read(run.ws, '.gitignore')).toBe('.splitbrief/\nnode_modules/\ndist/\n');
    });
  });

  itUnix('preserves equal modes after a clean merge and conflicts different modes', async () => {
    await withRun({ 'equal.sh': FIVE, 'different.sh': FIVE }, async (run) => {
      for (const path of ['equal.sh', 'different.sh']) {
        writeFileSync(join(run.ws, path), lines('ONE', 'two', 'three', 'four', 'five'));
        writeFileSync(join(run.dir, path), lines('one', 'two', 'three', 'four', 'FIVE'));
        chmodSync(join(run.ws, path), 0o755);
      }
      chmodSync(join(run.dir, 'equal.sh'), 0o755);

      const result = await merge(run);

      expect(result.promote).toEqual(['equal.sh']);
      expect(result.conflicts).toMatchObject([{ path: 'different.sh', kind: 'mode' }]);
      expect(result.conflicts[0]?.markers).toBeUndefined();
      expect(read(run.ws, 'different.sh')).toBe(lines('ONE', 'two', 'three', 'four', 'five'));
      expect(read(run.ws, 'equal.sh')).toBe(lines('ONE', 'two', 'three', 'four', 'FIVE'));
      expect(mode(run.ws, 'equal.sh')).toBe(0o755);
    });
  });

  it('refuses a text merge when only the base contains a NUL byte', async () => {
    await withRun({ 'a.txt': 'base\0\n' }, async (run) => {
      writeFileSync(join(run.ws, 'a.txt'), 'ours\n');
      writeFileSync(join(run.dir, 'a.txt'), 'theirs\n');

      const result = await merge(run);

      expect(result.promote).toEqual([]);
      expect(result.conflicts).toMatchObject([{ path: 'a.txt', kind: 'binary' }]);
      expect(result.conflicts[0]?.markers).toBeUndefined();
      expect(read(run.ws, 'a.txt')).toBe('ours\n');
    });
  });

  it('conflicts divergent changes when stored base blobs fail validation', async () => {
    await withRun({ 'a.txt': FIVE }, async (run) => {
      const blobs = snapshotFilesDir(
        { projectDir: run.dir, sessionId: SESSION_ID },
        run.workspace.base.snapshotId,
      );
      for (const name of readdirSync(blobs)) writeFileSync(join(blobs, name), 'corrupt');
      const baseline = snapshotFilesDir(
        { projectDir: run.dir, sessionId: SESSION_ID },
        SNAPSHOT_BASELINE_ID,
      );
      for (const name of readdirSync(baseline)) writeFileSync(join(baseline, name), 'corrupt');
      writeFileSync(join(run.ws, 'a.txt'), lines('ONE', 'two', 'three', 'four', 'five'));
      writeFileSync(join(run.dir, 'a.txt'), lines('one', 'two', 'three', 'four', 'FIVE'));

      const result = await merge(run);

      expect(result.promote).toEqual([]);
      expect(result.conflicts).toMatchObject([{ path: 'a.txt', kind: 'text' }]);
      expect(result.conflicts[0]?.markers).toBeUndefined();
    });
  });

  it('conflicts divergent changes when the base hash has no manifest entry or baseline entry', async () => {
    await withRun({ 'a.txt': FIVE }, async (run) => {
      const ref = { projectDir: run.dir, sessionId: SESSION_ID };
      for (const snapshotId of [run.workspace.base.snapshotId, SNAPSHOT_BASELINE_ID]) {
        const manifest = await readManifest(run.dir, SESSION_ID, snapshotId);
        writeFileSync(
          snapshotManifestPath(ref, snapshotId),
          JSON.stringify({
            ...manifest,
            fileEntries: manifest.fileEntries.filter((entry) => entry.path !== 'a.txt'),
          }),
        );
      }
      const ours = lines('ONE', 'two', 'three', 'four', 'five');
      writeFileSync(join(run.ws, 'a.txt'), ours);
      writeFileSync(join(run.dir, 'a.txt'), lines('one', 'two', 'three', 'four', 'FIVE'));
      const states = await captureApplyStates({
        projectDir: run.dir,
        sessionId: SESSION_ID,
        workspace: run.workspace,
      });

      expect(states.base.get('a.txt')).toEqual({
        kind: 'file',
        sha256: expect.any(String),
        blob: null,
      });
      const result = await mergeApplyStates(states);

      expect(result.promote).toEqual([]);
      expect(result.conflicts).toMatchObject([{ path: 'a.txt', kind: 'text' }]);
      expect(result.conflicts).toHaveLength(1);
      expect(result.conflicts[0]?.markers).toBeUndefined();
      expect(read(run.ws, 'a.txt')).toBe(ours);
    });
  });
});

describe('dirty-base-assessed-bytes', { timeout: 60_000 }, () => {
  const HEAD_TEXT = lines('head', 'two', 'three', 'four', 'five');
  const DIRTY = lines('dirty', 'two', 'three', 'four', 'five');

  it('merges against the dirty bytes the run started from, not HEAD', async () => {
    await withRun(
      { 'src.txt': HEAD_TEXT },
      async (run) => {
        expect(read(run.ws, 'src.txt')).toBe(DIRTY);
        writeFileSync(join(run.ws, 'src.txt'), lines('dirty', 'two', 'three', 'four', 'OURS'));
        writeFileSync(join(run.dir, 'src.txt'), lines('head', 'two', 'THEIRS', 'four', 'five'));

        const result = await merge(run);

        expect(result.conflicts).toEqual([]);
        expect(result.promote).toEqual(['src.txt']);
        expect(read(run.ws, 'src.txt')).toBe(lines('head', 'two', 'THEIRS', 'four', 'OURS'));
      },
      (dir) => writeFileSync(join(dir, 'src.txt'), DIRTY),
    );
  });

  it('rejects a checkout that changes after its state was captured', async () => {
    await withRun({ 'src.txt': FIVE }, async (run) => {
      writeFileSync(join(run.ws, 'src.txt'), lines('ONE', 'two', 'three', 'four', 'five'));
      writeFileSync(join(run.dir, 'src.txt'), lines('one', 'two', 'three', 'four', 'FIVE'));
      const states = await captureApplyStates({
        projectDir: run.dir,
        sessionId: SESSION_ID,
        workspace: run.workspace,
      });
      writeFileSync(join(run.dir, 'src.txt'), lines('one', 'two', 'LATE', 'four', 'five'));

      await expect(mergeApplyStates(states)).rejects.toMatchObject({
        kind: 'apply-checkout-changed',
      });
      expect(read(run.ws, 'src.txt')).toBe(lines('ONE', 'two', 'three', 'four', 'five'));
    });
  });

  it.each(['ours', 'theirs'] as const)(
    'rejects a file added to %s after capture before writing the workspace',
    async (side) => {
      await withRun({ 'a.txt': 'before\n' }, async (run) => {
        writeFileSync(join(run.dir, 'a.txt'), 'owner edit\n');
        const states = await captureApplyStates({
          projectDir: run.dir,
          sessionId: SESSION_ID,
          workspace: run.workspace,
        });
        const root = side === 'ours' ? run.ws : run.dir;
        writeFileSync(join(root, 'z.txt'), 'late addition\n');

        await expect(mergeApplyStates(states)).rejects.toMatchObject({
          kind: side === 'ours' ? 'apply-workspace-changed' : 'apply-checkout-changed',
          data: { path: 'z.txt' },
        });
        expect(read(run.ws, 'a.txt')).toBe('before\n');
        expect(read(root, 'z.txt')).toBe('late addition\n');
        expect(existsSync(join(run.ws, 'z.txt'))).toBe(side === 'ours');
      });
    },
  );

  it('rejects a base blob corrupted after capture before writing any workspace path', async () => {
    await withRun({ 'a.txt': 'before\n', 'z.txt': FIVE }, async (run) => {
      const ours = lines('ONE', 'two', 'three', 'four', 'five');
      writeFileSync(join(run.dir, 'a.txt'), 'owner edit\n');
      writeFileSync(join(run.ws, 'z.txt'), ours);
      writeFileSync(join(run.dir, 'z.txt'), lines('one', 'two', 'three', 'four', 'FIVE'));
      const states = await captureApplyStates({
        projectDir: run.dir,
        sessionId: SESSION_ID,
        workspace: run.workspace,
      });
      const base = states.base.get('z.txt');
      if (base?.kind !== 'file' || base.blob === null) {
        throw new Error('Expected a validated base blob');
      }
      writeFileSync(base.blob, 'corrupt\n');

      await expect(mergeApplyStates(states)).rejects.toMatchObject({
        kind: 'apply-base-changed',
        data: { path: 'z.txt' },
      });
      expect(read(run.ws, 'a.txt')).toBe('before\n');
      expect(read(run.ws, 'z.txt')).toBe(ours);
    });
  });

  it.each(['ours', 'theirs'] as const)(
    'checks a later divergent %s input before writing an earlier path',
    async (side) => {
      await withRun({ 'a.txt': 'before\n', 'z.txt': FIVE }, async (run) => {
        writeFileSync(join(run.dir, 'a.txt'), 'owner edit\n');
        writeFileSync(join(run.ws, 'z.txt'), lines('ONE', 'two', 'three', 'four', 'five'));
        writeFileSync(join(run.dir, 'z.txt'), lines('one', 'two', 'three', 'four', 'FIVE'));
        const states = await captureApplyStates({
          projectDir: run.dir,
          sessionId: SESSION_ID,
          workspace: run.workspace,
        });
        const changedDir = side === 'ours' ? run.ws : run.dir;
        writeFileSync(join(changedDir, 'z.txt'), 'later edit\n');

        await expect(mergeApplyStates(states)).rejects.toMatchObject({
          kind: side === 'ours' ? 'apply-workspace-changed' : 'apply-checkout-changed',
          data: { path: 'z.txt' },
        });
        expect(read(run.ws, 'a.txt')).toBe('before\n');
        expect(read(changedDir, 'z.txt')).toBe('later edit\n');
      });
    },
  );

  itUnix.each(['ours', 'theirs'] as const)(
    'checks a promotion-only %s fingerprint before writing any path',
    async (side) => {
      await withRun({ 'a.txt': 'before\n', 'z.txt': FIVE }, async (run) => {
        writeFileSync(join(run.dir, 'a.txt'), 'owner edit\n');
        writeFileSync(join(run.ws, 'z.txt'), 'run edit\n');
        const states = await captureApplyStates({
          projectDir: run.dir,
          sessionId: SESSION_ID,
          workspace: run.workspace,
        });
        chmodSync(join(side === 'ours' ? run.ws : run.dir, 'z.txt'), 0o755);

        await expect(mergeApplyStates(states)).rejects.toMatchObject({
          kind: side === 'ours' ? 'apply-workspace-changed' : 'apply-checkout-changed',
          data: { path: 'z.txt' },
        });
        expect(read(run.ws, 'a.txt')).toBe('before\n');
        expect(read(run.ws, 'z.txt')).toBe('run edit\n');
      });
    },
  );
});

describe('captureApplyStates', { timeout: 60_000 }, () => {
  it('captures the checkout fingerprints once for the promotion guard', async () => {
    await withRun({ 'a.txt': FIVE }, async (run) => {
      mkdirSync(join(run.dir, 'dir'));
      writeFileSync(join(run.dir, 'dir', 'x.txt'), 'x\n');

      const states = await captureApplyStates({
        projectDir: run.dir,
        sessionId: SESSION_ID,
        workspace: run.workspace,
      });

      expect([...states.theirsBaseline.keys()]).toEqual(
        expect.arrayContaining(['a.txt', 'dir/x.txt']),
      );
    });
  });
});
