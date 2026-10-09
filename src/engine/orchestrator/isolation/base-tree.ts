import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { runBaseTreesRoot } from '../../../core/paths.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { createGitClient } from '../../../lib/git/client.js';
import { reconcileWorkspaceToBase } from './acquisition.js';
import { initWorktreeSubmodules } from './create-worktree.js';
import { linkProjectNodeModules } from './worktree.js';

export type RunBase = {
  projectDir: string;
  sessionId: string;
  snapshotId: string;
  head: string | null;
};

export type RunBaseTree = { dir: string; incomplete?: string | undefined };

/** Reads the recorded snapshot and commit, or returns undefined when the run recorded no workspace. */
export function runBaseOf(
  ref: { projectDir: string; sessionId: string },
  state: Pick<WorkflowState, 'workspace'>,
): RunBase | undefined {
  if (state.workspace === undefined) return undefined;
  return {
    projectDir: ref.projectDir,
    sessionId: ref.sessionId,
    snapshotId: state.workspace.base.snapshotId,
    head: state.workspace.base.head,
  };
}

/**
 * Materialises the run base outside the project as the run workspace is built: a detached worktree
 * at the base commit reconciled to the base snapshot, or, with no commit, an incomplete snapshot
 * copy. Removes it after use, including on failure.
 */
export async function withRunBaseTree<T>(
  base: RunBase,
  use: (tree: RunBaseTree) => Promise<T>,
): Promise<T> {
  const git = createGitClient(base.projectDir);
  await mkdir(runBaseTreesRoot(), { recursive: true });
  const dir = await mkdtemp(join(runBaseTreesRoot(), 'base-'));
  let registered = false;
  try {
    if (base.head !== null) {
      await git.raw(['worktree', 'add', '--detach', dir, base.head]);
      registered = true;
      await initWorktreeSubmodules(base.projectDir, dir, git);
    }
    await reconcileWorkspaceToBase({ ...base, workspaceDir: dir, keep: [] });
    await linkProjectNodeModules(base.projectDir, dir);
    return await use({
      dir,
      ...(base.head === null && {
        incomplete:
          'the run recorded no base commit, so its run base copy has no Git history, file modes or symlinks',
      }),
    });
  } finally {
    try {
      if (registered) await git.raw(['worktree', 'remove', '--force', dir]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}
