import { execSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, isAbsolute, join, relative } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { withApplyRun, type ApplyRun } from '#testing/helpers/apply-run.js';
import { runBaseTreesRoot } from '../../../core/paths.js';
import { runBaseOf, withRunBaseTree } from './base-tree.js';
import { runBaseTreeError } from './errors.js';

const FILES = {
  'src/legacy.ts': 'export const legacy = 1;\n',
  'src/legacy.test.ts': "import { legacy } from './legacy.js';\n",
};

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function git(dir: string, args: string): string {
  return execSync(`git ${args}`, { cwd: dir, stdio: 'pipe', encoding: 'utf8' });
}

function baseOf(run: ApplyRun) {
  const base = runBaseOf(
    { projectDir: run.dir, sessionId: run.sessionId },
    { workspace: run.workspace },
  );
  if (base === undefined) throw new Error('The run recorded no workspace base');
  return base;
}

/**
 * Commits what a snapshot of file contents cannot carry: an executable script, a symlink and a
 * file under a nested `.splitbrief/` directory. The gate of a real project reads all three.
 */
function commitTreeOnlyEntries(dir: string): void {
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  writeFileSync(join(dir, 'scripts/hook.sh'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(dir, 'scripts/hook.sh'), 0o755);
  symlinkSync('src/legacy.ts', join(dir, 'legacy-link.ts'));
  mkdirSync(join(dir, 'fixtures/p/.splitbrief'), { recursive: true });
  writeFileSync(join(dir, 'fixtures/p/.splitbrief/config.yaml'), 'version: 3\n');
  git(dir, 'add scripts/hook.sh legacy-link.ts');
  git(dir, 'add -f fixtures/p/.splitbrief/config.yaml');
  git(dir, 'commit -q -m tree-only');
}

describe('withRunBaseTree', { timeout: 60_000 }, () => {
  it('materialises the run base outside the project and the workspace, adds no ref, then removes it', async () => {
    await withApplyRun(
      FILES,
      {
        sessionId: 'sess-base-tree',
        atBase: (dir) => {
          commitTreeOnlyEntries(dir);
          // An uncommitted edit the run started from belongs to the run base.
          writeFileSync(join(dir, 'src/legacy.ts'), 'export const legacy = 2;\n');
        },
      },
      async (run) => {
        mkdirSync(join(run.dir, 'node_modules', 'dep'), { recursive: true });
        writeFileSync(join(run.ws, 'src/legacy.ts'), 'export const legacy = 3;\n');
        writeFileSync(join(run.ws, 'src/added.ts'), 'export const added = 1;\n');
        const refs = git(run.dir, 'for-each-ref');
        const worktrees = git(run.dir, 'worktree list --porcelain');

        const first = git(run.dir, 'rev-parse HEAD~1').trim();

        let tree = '';
        const legacy = await withRunBaseTree(baseOf(run), async ({ dir, incomplete }) => {
          tree = dir;
          expect(incomplete).toBeUndefined();
          expect(inside(run.dir, dir)).toBe(false);
          expect(inside(run.ws, dir)).toBe(false);
          expect(readFileSync(join(dir, 'src/legacy.test.ts'), 'utf-8')).toBe(
            FILES['src/legacy.test.ts'],
          );
          expect(existsSync(join(dir, 'src/added.ts'))).toBe(false);
          expect(lstatSync(join(dir, 'node_modules')).isSymbolicLink()).toBe(true);
          // A Git checkout of the recorded head, with its history, as the run workspace has.
          expect(git(dir, 'rev-parse HEAD').trim()).toBe(run.workspace.base.head);
          expect(() => git(dir, `cat-file -e ${first}^{commit}`)).not.toThrow();
          expect(git(dir, 'ls-files')).toContain('scripts/hook.sh');
          expect(statSync(join(dir, 'scripts/hook.sh')).mode & 0o111).not.toBe(0);
          expect(readlinkSync(join(dir, 'legacy-link.ts'))).toBe('src/legacy.ts');
          expect(readFileSync(join(dir, 'fixtures/p/.splitbrief/config.yaml'), 'utf-8')).toBe(
            'version: 3\n',
          );
          expect(git(run.dir, 'for-each-ref')).toBe(refs);
          return readFileSync(join(dir, 'src/legacy.ts'), 'utf-8');
        });

        expect(legacy).toBe('export const legacy = 2;\n');
        expect(tree).not.toBe('');
        expect(existsSync(tree)).toBe(false);
        expect(git(run.dir, 'for-each-ref')).toBe(refs);
        expect(git(run.dir, 'worktree list --porcelain')).toBe(worktrees);
      },
    );
  });

  it('removes the tree when the work inside it throws', async () => {
    await withApplyRun(FILES, { sessionId: 'sess-base-tree-throws' }, async (run) => {
      const worktrees = git(run.dir, 'worktree list --porcelain');
      let tree = '';
      await expect(
        withRunBaseTree(baseOf(run), async ({ dir }) => {
          tree = dir;
          throw new Error('stage crashed');
        }),
      ).rejects.toThrow('stage crashed');
      expect(tree).not.toBe('');
      expect(existsSync(tree)).toBe(false);
      expect(git(run.dir, 'worktree list --porcelain')).toBe(worktrees);
    });
  });

  // C3 review: an unreachable base commit crashed the review and left the base row running.
  it('throws checkoutFailed with the Git error when the base commit cannot be checked out, and leaves nothing behind', async () => {
    await withApplyRun(FILES, { sessionId: 'sess-base-tree-unreachable' }, async (run) => {
      const worktrees = git(run.dir, 'worktree list --porcelain');
      mkdirSync(runBaseTreesRoot(), { recursive: true });
      const before = readdirSync(runBaseTreesRoot());
      const use = vi.fn();
      const failed = await withRunBaseTree({ ...baseOf(run), head: 'f'.repeat(40) }, use).then(
        () => undefined,
        (err: unknown) => err,
      );

      expect(runBaseTreeError.isCheckoutFailed(failed)).toBe(true);
      expect(failed).toHaveProperty(
        'message',
        expect.stringContaining('the run base could not be checked out'),
      );
      expect(failed).toHaveProperty('message', expect.stringContaining('f'.repeat(40)));
      expect(use).not.toHaveBeenCalled();
      expect(readdirSync(runBaseTreesRoot())).toEqual(before);
      expect(git(run.dir, 'worktree list --porcelain')).toBe(worktrees);
    });
  });

  // C3 review: a SIGKILL during a base re-run left its tree and its `.git/worktrees/base-*`
  // registration forever.
  it('removes the base trees of a process that is gone and their registrations, and keeps a live process tree', async () => {
    await withApplyRun(FILES, { sessionId: 'sess-base-tree-sweep' }, async (run) => {
      mkdirSync(runBaseTreesRoot(), { recursive: true });
      const gone = spawnSync(process.execPath, ['-e', '']).pid;
      const stale = join(runBaseTreesRoot(), `base-${gone}-stale`);
      const live = join(runBaseTreesRoot(), `base-${process.pid}-live`);
      const unowned = join(runBaseTreesRoot(), 'base-unowned');
      git(run.dir, `worktree add --detach ${JSON.stringify(stale)} HEAD`);
      git(run.dir, `worktree add --detach ${JSON.stringify(live)} HEAD`);
      // Git names a registration after the tree's directory, whatever path form it prints.
      const registered = (tree: string) =>
        existsSync(join(run.dir, '.git', 'worktrees', basename(tree)));
      expect(registered(stale)).toBe(true);
      mkdirSync(unowned);
      try {
        await withRunBaseTree(baseOf(run), async () => undefined);

        expect(existsSync(stale)).toBe(false);
        expect(registered(stale)).toBe(false);
        expect(existsSync(live)).toBe(true);
        expect(registered(live)).toBe(true);
        expect(existsSync(unowned)).toBe(true);
      } finally {
        git(run.dir, `worktree remove --force ${JSON.stringify(live)}`);
        rmSync(unowned, { recursive: true, force: true });
      }
    });
  });

  it('names the base a staged-copy run started from, and why its copy is incomplete', async () => {
    await withApplyRun(
      FILES,
      { sessionId: 'sess-base-tree-staged', strategy: 'staged-copy' },
      async (run) => {
        writeFileSync(join(run.ws, 'src/legacy.ts'), 'export const legacy = 9;\n');
        const seen = await withRunBaseTree(baseOf(run), async ({ dir, incomplete }) => ({
          legacy: readFileSync(join(dir, 'src/legacy.ts'), 'utf-8'),
          git: existsSync(join(dir, '.git')),
          incomplete,
        }));
        expect(seen).toEqual({
          legacy: FILES['src/legacy.ts'],
          git: false,
          incomplete:
            'the run recorded no base commit, so its run base copy has no Git history, file modes or symlinks',
        });
      },
    );
  });
});

describe('runBaseOf', () => {
  it('reads the workspace-base snapshot the run recorded', () => {
    expect(
      runBaseOf(
        { projectDir: '/repo', sessionId: 'sess-1' },
        {
          workspace: {
            kind: 'worktree',
            path: '/state/trees/abc/sess-1',
            base: { snapshotId: 'snap-base', head: 'abc123' },
          },
        },
      ),
    ).toEqual({
      projectDir: '/repo',
      sessionId: 'sess-1',
      snapshotId: 'snap-base',
      head: 'abc123',
    });
  });

  it('has no run base for an older run that recorded no workspace', () => {
    expect(runBaseOf({ projectDir: '/repo', sessionId: 'sess-1' }, {})).toBeUndefined();
  });
});
