import { execSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { withTempDir } from '#testing/helpers/temp-dir.js';
import {
  checkoutChanges,
  formatCheckoutChanges,
  snapshotCheckout,
  snapshotWorkspaceGit,
  workspaceGitChanges,
} from './checkout-audit.js';

async function withCheckout(run: (dir: string) => Promise<void>): Promise<void> {
  await withTempDir('splitbrief-checkout-audit', async (dir) => {
    createTestGitRepo(dir, {
      '.gitignore': 'node_modules\n',
      'src/a.ts': 'export const a = 1;\n',
    });
    mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'pkg', 'package.json'), '{}');
    await run(dir);
  });
}

async function changesAcross(
  dir: string,
  act: () => void,
): Promise<{ files: string[]; state: string[] }> {
  const before = await snapshotCheckout(dir);
  act();
  return checkoutChanges({ before, after: await snapshotCheckout(dir) });
}

function git(dir: string, command: string): void {
  execSync(`git ${command}`, { cwd: dir, stdio: 'pipe' });
}

describe('checkout audit', () => {
  it('finds nothing when the call left the checkout alone', async () => {
    await withCheckout(async (dir) => {
      expect(await changesAcross(dir, () => undefined)).toEqual({ files: [], state: [] });
    });
  });

  it('names a tracked file written, a file created, and a dirty file rewritten', async () => {
    await withCheckout(async (dir) => {
      writeFileSync(join(dir, 'notes.md'), 'dirty before the call\n');
      expect(
        await changesAcross(dir, () => {
          writeFileSync(join(dir, 'src/a.ts'), 'export const a = 2;\n');
          writeFileSync(join(dir, 'src/b.ts'), 'export const b = 1;\n');
          writeFileSync(join(dir, 'notes.md'), 'rewritten during the call\n');
        }),
      ).toEqual({ files: ['notes.md', 'src/a.ts', 'src/b.ts'], state: [] });
    });
  });

  it('names a new branch, a new tag and a stash as git state', async () => {
    await withCheckout(async (dir) => {
      expect(await changesAcross(dir, () => git(dir, 'branch topic'))).toEqual({
        files: [],
        state: ['branch topic'],
      });
      expect(await changesAcross(dir, () => git(dir, 'tag v1'))).toEqual({
        files: [],
        state: ['tag v1'],
      });
      writeFileSync(join(dir, 'src/a.ts'), 'export const a = 3;\n');
      expect(await changesAcross(dir, () => git(dir, 'stash -q'))).toEqual({
        files: ['src/a.ts'],
        state: ['stash'],
      });
    });
  });

  it("lets the checkout's HEAD and its current branch move: Apply merges those", async () => {
    await withCheckout(async (dir) => {
      git(dir, 'branch topic');
      expect(
        await changesAcross(dir, () => {
          writeFileSync(join(dir, 'src/a.ts'), 'export const a = 2;\n');
          git(dir, 'commit -qam user-commit');
        }),
      ).toEqual({ files: [], state: [] });
      expect(await changesAcross(dir, () => git(dir, 'switch -q topic'))).toEqual({
        files: [],
        state: [],
      });
    });
  });

  it('names a planted hook and a changed git config', async () => {
    await withCheckout(async (dir) => {
      expect(
        await changesAcross(dir, () =>
          writeFileSync(join(dir, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\ncurl evil\n'),
        ),
      ).toEqual({ files: [], state: ['hook pre-commit'] });
      expect(await changesAcross(dir, () => git(dir, 'config user.name Mallory'))).toEqual({
        files: [],
        state: ['git config'],
      });
    });
  });

  it('names an install into the checkout node_modules, not a tool cache beside it', async () => {
    await withCheckout(async (dir) => {
      expect(
        await changesAcross(dir, () => {
          mkdirSync(join(dir, 'node_modules', '.vite', 'vitest'), { recursive: true });
          mkdirSync(join(dir, 'node_modules', '.cache', 'eslint'), { recursive: true });
        }),
      ).toEqual({ files: [], state: [] });
      expect(
        await changesAcross(dir, () => {
          mkdirSync(join(dir, 'node_modules', 'lodash'));
          writeFileSync(join(dir, 'node_modules', '.package-lock.json'), '{}');
        }),
      ).toEqual({ files: [], state: ['node_modules'] });
    });
  });

  it('ignores a build cache the checkout gitignores', async () => {
    await withCheckout(async (dir) => {
      writeFileSync(join(dir, '.gitignore'), 'node_modules\n*.tsbuildinfo\n');
      git(dir, 'commit -qam ignore-buildinfo');
      expect(
        await changesAcross(dir, () => writeFileSync(join(dir, 'tsconfig.tsbuildinfo'), '{}')),
      ).toEqual({ files: [], state: [] });
    });
  });

  it("ignores SPLITBRIEF's own session files and isolation branches", async () => {
    await withCheckout(async (dir) => {
      expect(
        await changesAcross(dir, () => {
          mkdirSync(join(dir, '.splitbrief', 'sessions', 's1'), { recursive: true });
          writeFileSync(join(dir, '.splitbrief', 'sessions', 's1', 'session.jsonl'), '{}\n');
          git(dir, 'branch splitbrief/run-2');
        }),
      ).toEqual({ files: [], state: [] });
    });
  });

  it('audits a checkout that is not a git repository by its files', async () => {
    await withTempDir('splitbrief-checkout-audit-plain', async (dir) => {
      writeFileSync(join(dir, 'a.txt'), 'one\n');
      expect(await changesAcross(dir, () => writeFileSync(join(dir, 'a.txt'), 'two\n'))).toEqual({
        files: ['a.txt'],
        state: [],
      });
    });
  });
});

async function withRunWorktree(run: (worktree: string) => Promise<void>): Promise<void> {
  await withCheckout(async (checkout) => {
    await withTempDir('splitbrief-run-worktree', async (worktree) => {
      git(checkout, `worktree add -q -b splitbrief/run-1 ${worktree}`);
      await run(worktree);
    });
  });
}

async function workspaceChangesAcross(worktree: string, act: () => void): Promise<string[]> {
  const before = await snapshotWorkspaceGit(worktree);
  act();
  return workspaceGitChanges({ before, after: await snapshotWorkspaceGit(worktree) });
}

describe('run worktree audit', () => {
  it('finds nothing when the call only edited files and read git status', async () => {
    await withRunWorktree(async (worktree) => {
      expect(
        await workspaceChangesAcross(worktree, () => {
          writeFileSync(join(worktree, 'src/a.ts'), 'export const a = 2;\n');
          git(worktree, 'status --porcelain');
          git(worktree, 'diff');
        }),
      ).toEqual([]);
    });
  });

  it('names a stage inside the run worktree', async () => {
    await withRunWorktree(async (worktree) => {
      writeFileSync(join(worktree, 'src/a.ts'), 'export const a = 2;\n');
      expect(await workspaceChangesAcross(worktree, () => git(worktree, 'add src/a.ts'))).toEqual([
        'run worktree index',
      ]);
    });
  });

  it('names a commit on the run branch', async () => {
    await withRunWorktree(async (worktree) => {
      writeFileSync(join(worktree, 'src/a.ts'), 'export const a = 2;\n');
      git(worktree, 'add src/a.ts');
      expect(
        await workspaceChangesAcross(worktree, () => git(worktree, 'commit -qm escaped')),
      ).toEqual(['run worktree branch splitbrief/run-1']);
    });
  });

  it('names a run worktree moved off its branch', async () => {
    await withRunWorktree(async (worktree) => {
      expect(
        await workspaceChangesAcross(worktree, () => git(worktree, 'switch -q --detach')),
      ).toEqual(['run worktree HEAD']);
    });
  });

  it('names a skip-worktree flag set on the run worktree index', async () => {
    await withRunWorktree(async (worktree) => {
      expect(
        await workspaceChangesAcross(worktree, () =>
          git(worktree, 'update-index --skip-worktree src/a.ts'),
        ),
      ).toEqual(['run worktree index']);
    });
  });

  it('names a run worktree moved to an unborn branch', async () => {
    await withRunWorktree(async (worktree) => {
      expect(
        await workspaceChangesAcross(worktree, () => git(worktree, 'switch -q --orphan fresh')),
      ).toEqual(['run worktree HEAD', 'run worktree index']);
    });
  });

  it('names a run worktree that lost its git', async () => {
    await withRunWorktree(async (worktree) => {
      expect(await workspaceChangesAcross(worktree, () => rmSync(join(worktree, '.git')))).toEqual([
        'run worktree git',
      ]);
    });
  });

  it('reads no git of its own for a staged copy inside the checkout', async () => {
    await withCheckout(async (checkout) => {
      const staged = join(checkout, '.splitbrief', 'sessions', 's1', 'stage-1');
      mkdirSync(staged, { recursive: true });
      expect(await snapshotWorkspaceGit(staged)).toBeNull();
    });
  });
});

describe('formatCheckoutChanges', () => {
  it('lists what changed and counts what it does not list', () => {
    expect(formatCheckoutChanges(['src/a.ts', 'branch main'])).toBe('src/a.ts · branch main');
    const many = Array.from({ length: 11 }, (_, index) => `f${index}.ts`);
    expect(formatCheckoutChanges(many)).toBe(
      'f0.ts · f1.ts · f2.ts · f3.ts · f4.ts · f5.ts · f6.ts · f7.ts · 3 more',
    );
  });
});
