import { execSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { withApplyRun, type ApplyRun } from '#testing/helpers/apply-run.js';
import { runBaseOf, withRunBaseTree } from './base-tree.js';

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

describe('withRunBaseTree', { timeout: 60_000 }, () => {
  it('materialises the run base outside the project and the workspace, adds no ref, then removes it', async () => {
    await withApplyRun(
      FILES,
      {
        sessionId: 'sess-base-tree',
        // An uncommitted edit the run started from belongs to the run base.
        atBase: (dir) => writeFileSync(join(dir, 'src/legacy.ts'), 'export const legacy = 2;\n'),
      },
      async (run) => {
        mkdirSync(join(run.dir, 'node_modules', 'dep'), { recursive: true });
        writeFileSync(join(run.ws, 'src/legacy.ts'), 'export const legacy = 3;\n');
        writeFileSync(join(run.ws, 'src/added.ts'), 'export const added = 1;\n');
        const refs = git(run.dir, 'for-each-ref');
        const worktrees = git(run.dir, 'worktree list --porcelain');

        let tree = '';
        const legacy = await withRunBaseTree(baseOf(run), async (dir) => {
          tree = dir;
          expect(inside(run.dir, dir)).toBe(false);
          expect(inside(run.ws, dir)).toBe(false);
          expect(readFileSync(join(dir, 'src/legacy.test.ts'), 'utf-8')).toBe(
            FILES['src/legacy.test.ts'],
          );
          expect(existsSync(join(dir, 'src/added.ts'))).toBe(false);
          expect(lstatSync(join(dir, 'node_modules')).isSymbolicLink()).toBe(true);
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
      let tree = '';
      await expect(
        withRunBaseTree(baseOf(run), async (dir) => {
          tree = dir;
          throw new Error('stage crashed');
        }),
      ).rejects.toThrow('stage crashed');
      expect(tree).not.toBe('');
      expect(existsSync(tree)).toBe(false);
    });
  });

  it('names the base a staged-copy run started from', async () => {
    await withApplyRun(
      FILES,
      { sessionId: 'sess-base-tree-staged', strategy: 'staged-copy' },
      async (run) => {
        writeFileSync(join(run.ws, 'src/legacy.ts'), 'export const legacy = 9;\n');
        const legacy = await withRunBaseTree(baseOf(run), async (dir) =>
          readFileSync(join(dir, 'src/legacy.ts'), 'utf-8'),
        );
        expect(legacy).toBe(FILES['src/legacy.ts']);
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
    ).toEqual({ projectDir: '/repo', sessionId: 'sess-1', snapshotId: 'snap-base' });
  });

  it('has no run base for an older run that recorded no workspace', () => {
    expect(runBaseOf({ projectDir: '/repo', sessionId: 'sess-1' }, {})).toBeUndefined();
  });
});
