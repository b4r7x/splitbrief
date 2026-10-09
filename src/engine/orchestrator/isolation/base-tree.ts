import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { runBaseTreesRoot } from '../../../core/paths.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { createGitClient, type GitClient } from '../../../lib/git/client.js';
import { canSignalProcess } from '../../../lib/process/liveness.js';
import { reconcileWorkspaceToBase } from './acquisition.js';
import { initWorktreeSubmodules } from './create-worktree.js';
import { runBaseTreeError } from './errors.js';
import { linkProjectNodeModules } from './worktree.js';

export type RunBase = {
  projectDir: string;
  sessionId: string;
  snapshotId: string;
  head: string | null;
};

export type RunBaseTree = { dir: string; incomplete?: string | undefined };

/** A base tree is named after the process that owns it: `base-<pid>-<random>`. */
const BASE_TREE_NAME = /^base-(\d+)-/;

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
 * Removes the base trees whose owning process is gone, such as after a SIGKILL during a base
 * re-run. A recycled pid keeps its stale tree until that process ends too. Their Git registrations
 * go with the next `git worktree prune` in their own repository.
 */
async function removeStaleRunBaseTrees(): Promise<void> {
  for (const name of await readdir(runBaseTreesRoot())) {
    const owner = BASE_TREE_NAME.exec(name)?.[1];
    if (owner === undefined || canSignalProcess(Number(owner))) continue;
    await rm(join(runBaseTreesRoot(), name), { recursive: true, force: true });
  }
}

async function removeRunBaseTree(git: GitClient, dir: string, registered: boolean): Promise<void> {
  try {
    if (registered) await git.raw(['worktree', 'remove', '--force', dir]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Materialises the run base outside the project as the run workspace is built: a detached worktree
 * at the base commit reconciled to the base snapshot, or, with no commit, an incomplete snapshot
 * copy. Removes it after use, including on failure. A step that cannot check out the base, the
 * sweep of stale base trees included, throws `runBaseTreeError.checkoutFailed`.
 */
export async function withRunBaseTree<T>(
  base: RunBase,
  use: (tree: RunBaseTree) => Promise<T>,
): Promise<T> {
  const git = createGitClient(base.projectDir);
  await mkdir(runBaseTreesRoot(), { recursive: true });
  const dir = await mkdtemp(join(runBaseTreesRoot(), `base-${process.pid}-`));
  let registered = false;
  let result: T;
  try {
    if (base.head !== null) {
      try {
        await removeStaleRunBaseTrees();
        await git.raw(['worktree', 'prune']);
        await git.raw(['worktree', 'add', '--quiet', '--detach', dir, base.head]);
        registered = true;
        await initWorktreeSubmodules(base.projectDir, dir, git);
      } catch (err) {
        throw runBaseTreeError.checkoutFailed(err);
      }
    }
    await reconcileWorkspaceToBase({ ...base, workspaceDir: dir, keep: [] });
    await linkProjectNodeModules(base.projectDir, dir);
    result = await use({
      dir,
      ...(base.head === null && {
        incomplete:
          'the run recorded no base commit, so its run base copy has no Git history, file modes or symlinks',
      }),
    });
  } catch (err) {
    // The error in flight names the cause; the next sweep prunes a registration this leaves.
    await removeRunBaseTree(git, dir, registered).catch(() => undefined);
    throw err;
  }
  await removeRunBaseTree(git, dir, registered);
  return result;
}
