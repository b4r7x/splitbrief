import { mkdir, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { runBaseTreesRoot } from '../../../core/paths.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { createGitClient, runGit } from '../../../lib/git/client.js';
import { getGitCommonDir } from '../../../lib/git/repository.js';
import { isENOENT } from '../../../lib/process/errors.js';
import { canSignalProcess } from '../../../lib/process/liveness.js';
import { warnError } from '../../../lib/warn.js';
import { labelError } from '../../../utils/format-errors.js';
import { redactSecrets } from '../../../utils/redact.js';
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
 * re-run. A recycled pid keeps its stale tree until that process ends too. Older names without a
 * pid stay untouched. Each registered tree is removed through its own repository. A tree that
 * cannot be removed is reported as a warning and does not stop the current base re-run.
 */
async function removeStaleRunBaseTrees(): Promise<void> {
  for (const name of await readdir(runBaseTreesRoot())) {
    const owner = BASE_TREE_NAME.exec(name)?.[1];
    if (owner === undefined || canSignalProcess(Number(owner))) continue;
    const dir = join(runBaseTreesRoot(), name);
    try {
      await removeRunBaseTree(dir);
    } catch (err) {
      warnError(`Could not remove stale run base tree ${dir}`, err);
    }
  }
}

async function removeRunBaseTree(dir: string): Promise<void> {
  const gitEntry = join(dir, '.git');
  let registered = false;
  try {
    const entry = await stat(gitEntry);
    registered = true;
    if (entry.isFile()) {
      const gitdir = /^gitdir: (.+)$/m.exec(await readFile(gitEntry, 'utf8'))?.[1];
      if (gitdir !== undefined) await stat(resolve(dir, gitdir.trim()));
    }
  } catch (err) {
    if (!isENOENT(err)) throw err;
    registered = false;
  }
  if (registered) {
    await runGit(`worktree remove --force ${dir}`, async () => {
      const git = createGitClient(await getGitCommonDir(dir));
      await git.raw(['worktree', 'remove', '--force', dir]);
    });
    return;
  }
  await rm(dir, { recursive: true, force: true });
}

/**
 * Materialises the run base outside the project as the run workspace is built: a detached worktree
 * at the base commit reconciled to the base snapshot, or, with no commit, an incomplete snapshot
 * copy. A preparation failure throws `runBaseTreeError.preparationFailed` with the cleanup error
 * attached. A stale tree that cannot be removed is a warning and does not stop preparation. A
 * cleanup error after the callback completes comes back with its result; a callback error
 * propagates unchanged, and its cleanup error is a warning.
 */
export async function withRunBaseTree<T>(
  base: RunBase,
  use: (tree: RunBaseTree) => Promise<T>,
): Promise<{ result: T; cleanupError: string | undefined }> {
  let dir: string | undefined;
  try {
    const git = createGitClient(base.projectDir);
    await mkdir(runBaseTreesRoot(), { recursive: true });
    await removeStaleRunBaseTrees();
    dir = await mkdtemp(join(runBaseTreesRoot(), `base-${process.pid}-`));
    if (base.head !== null) {
      await git.raw(['worktree', 'add', '--quiet', '--detach', dir, base.head]);
      await initWorktreeSubmodules(base.projectDir, dir);
    }
    await reconcileWorkspaceToBase({ ...base, workspaceDir: dir, keep: [] });
    await linkProjectNodeModules(base.projectDir, dir);
  } catch (cause) {
    let cleanupError: unknown;
    if (dir !== undefined) {
      try {
        await removeRunBaseTree(dir);
      } catch (err) {
        cleanupError = err;
      }
    }
    throw runBaseTreeError.preparationFailed({ cause, cleanupError });
  }
  let result: T;
  try {
    result = await use({
      dir,
      ...(base.head === null && {
        incomplete:
          'the run recorded no base commit, so its run base copy has no Git history, file modes or symlinks',
      }),
    });
  } catch (err) {
    try {
      await removeRunBaseTree(dir);
    } catch (cleanupError) {
      warnError(`Could not remove run base tree ${dir} after the base re-run failed`, cleanupError);
    }
    throw err;
  }
  try {
    await removeRunBaseTree(dir);
  } catch (err) {
    return {
      result,
      cleanupError: redactSecrets(labelError(`cleanup of run base tree ${dir} failed`, err)),
    };
  }
  return { result, cleanupError: undefined };
}
