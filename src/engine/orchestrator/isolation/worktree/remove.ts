import { existsSync, realpathSync } from 'node:fs';
import { realpath, rm, rmdir } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import { SPLITBRIEF_IDENTITY } from '../../../../core/identity.js';
import { isolationTreesRoot } from '../../../../core/paths.js';
import { StagedWorkspaceLeafSchema } from '../../../../core/schemas/retained-workspace.js';
import type { SessionRef } from '../../../../core/types/session-ref.js';
import { createGitClient, type GitClient } from '../../../../lib/git/client.js';
import { getGitCommonDir } from '../../../../lib/git/repository.js';
import { isENOENT, isNodeError } from '../../../../utils/errno.js';
import { clearWorkspaceRecord, stagedWorkspaceRoot, retentionError } from '../retention.js';
import { isInsideRoot } from '../../../../lib/fs/confinement.js';
import {
  gitignoreDiffersOnlyBySplitbriefBookkeeping,
  shouldIgnoreWorktreeUncommittedPath,
} from '../../../../core/gitignore-bookkeeping.js';
import { resolveConfinedIsolationWorktreePath, resolveConfinedWorktreePath } from '../path.js';
import { findLiveWorktreeSession } from './status.js';
import { countNoun } from '../../../../utils/pluralize.js';

export type WorktreeWarningPublisher = (message: string) => void;

export type RemoveWorktreeOptions = {
  projectDir: string;
  slug: string;
  git: GitClient;
  // Run isolation places its worktree outside `.trees/` and resolves that path
  // itself; without it the slug names a directory under the project root.
  worktreeDir?: string;
  warningPublisher?: WorktreeWarningPublisher;
  // Run removal has explicit authority to discard the workspace's files.
  suppressUncommittedWarning?: boolean;
};

function publishWorktreeWarning(
  message: string,
  warningPublisher: WorktreeWarningPublisher | undefined,
): void {
  if (warningPublisher !== undefined) {
    warningPublisher(message);
    return;
  }
  process.stderr.write(message.endsWith('\n') ? message : `${message}\n`);
}

export async function isOwnRunWorkspace(
  ref: SessionRef,
  workspace: { kind: 'worktree' | 'staged-copy'; path: string },
): Promise<boolean> {
  if (workspace.kind === 'staged-copy') {
    const root = dirname(workspace.path);
    return (
      workspace.path === join(root, 'workspace') &&
      StagedWorkspaceLeafSchema.safeParse(basename(root)).success &&
      root === stagedWorkspaceRoot(ref, basename(root))
    );
  }
  const worktreeDir = resolveConfinedIsolationWorktreePath({
    projectDir: ref.projectDir,
    gitCommonDir: await getGitCommonDir(ref.projectDir),
    slug: ref.sessionId.slice(0, 64),
  });
  if (workspace.path !== worktreeDir) return false;
  if (existsSync(worktreeDir)) {
    const treesRoot = isolationTreesRoot();
    const canonicalPath = join(await realpath(treesRoot), relative(treesRoot, worktreeDir));
    if ((await realpath(worktreeDir)) !== canonicalPath) throw retentionError.unavailable();
  }
  return true;
}

export async function removeRunWorkspace(
  projectDir: string,
  sessionId: string,
  workspace: { kind: 'worktree' | 'staged-copy' | 'checkout'; path: string },
): Promise<string | null> {
  if (workspace.kind === 'checkout') return null;
  const ref = { projectDir, sessionId };
  if (!(await isOwnRunWorkspace(ref, { kind: workspace.kind, path: workspace.path }))) {
    clearWorkspaceRecord(ref);
    return existsSync(workspace.path) ? workspace.path : null;
  }
  if (workspace.kind === 'worktree') {
    await removeWorktree({
      projectDir,
      slug: sessionId.slice(0, 64),
      git: createGitClient(projectDir),
      worktreeDir: workspace.path,
      suppressUncommittedWarning: true,
    });
    await removeEmptyRepositoryRoot(workspace.path);
  } else {
    await rm(dirname(workspace.path), { recursive: true, force: true });
  }
  clearWorkspaceRecord(ref);
  return null;
}

async function removeEmptyRepositoryRoot(worktreeDir: string): Promise<void> {
  try {
    await rmdir(dirname(worktreeDir));
  } catch (err) {
    if (isENOENT(err) || (isNodeError(err) && err.code === 'ENOTEMPTY')) return;
    throw err;
  }
}

// An isolation worktree lives outside the project root when the project is
// itself a linked worktree, and a `../../` walk is worse than the full path.
function worktreeLabel(projectDir: string, wtPath: string): string {
  return isInsideRoot(projectDir, wtPath) ? relative(projectDir, wtPath) : wtPath;
}

export async function removeWorktree(opts: RemoveWorktreeOptions): Promise<void> {
  const { projectDir, slug, git, warningPublisher, suppressUncommittedWarning = false } = opts;
  const wtPath = opts.worktreeDir ?? resolveConfinedWorktreePath(projectDir, slug);
  const label = worktreeLabel(projectDir, wtPath);
  const registration = await findWorktreeRegistration(git, wtPath);
  // An older version put each run worktree on its own `splitbrief/<slug>` branch.
  // A detached run worktree has no branch to delete.
  const oldRunBranch = `${SPLITBRIEF_IDENTITY.branchPrefix}${slug}`;
  const ownsOldRunBranch = registration?.branch === `refs/heads/${oldRunBranch}`;

  if (!existsSync(wtPath)) {
    // A `git worktree prune`, by the user or by the close of another run, already removed it.
    if (registration === undefined) {
      if ((await git.raw(['branch', '--list', oldRunBranch])).trim() !== '') {
        await git.raw(['branch', '-D', oldRunBranch]);
      }
      return;
    }
    await git.raw(['worktree', 'prune']);
    if (ownsOldRunBranch) {
      await git.raw(['branch', '-D', oldRunBranch]);
    }
    return;
  }

  const live = await findLiveWorktreeSession(wtPath);

  const porcelain = await createGitClient(wtPath).raw(['status', '--porcelain']);
  const porcelainPaths = porcelain
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.slice(line.indexOf(' ') + 1).trim());
  const gitignoreOnlyBookkeeping = await gitignoreDiffersOnlyBySplitbriefBookkeeping(wtPath);
  const uncommittedPaths = porcelainPaths.filter(
    (path) => !shouldIgnoreWorktreeUncommittedPath(path, gitignoreOnlyBookkeeping),
  );

  if (live !== null) {
    publishWorktreeWarning(
      `Warning: forcing removal of worktree "${label}" with live session ${live.sessionId}.`,
      warningPublisher,
    );
  }
  if (uncommittedPaths.length > 0 && !suppressUncommittedWarning) {
    publishWorktreeWarning(
      `Warning: forcing removal of worktree "${label}" with ${countNoun(uncommittedPaths.length, 'uncommitted file')}.`,
      warningPublisher,
    );
  }

  await git.raw(['worktree', 'remove', wtPath, '--force']);

  if (ownsOldRunBranch) {
    await git.raw(['branch', '-D', oldRunBranch]);
  }
}

// Git lists each worktree at its real path; a removed directory keeps its entry until a prune.
async function findWorktreeRegistration(
  git: GitClient,
  wtPath: string,
): Promise<{ branch: string | undefined } | undefined> {
  const target = `worktree ${realPathOf(wtPath)}`;
  const porcelain = await git.raw(['worktree', 'list', '--porcelain']);
  const entry = porcelain
    .split('\n\n')
    .map((block) => block.split('\n'))
    .find((lines) => lines[0] === target);
  if (entry === undefined) return undefined;
  return { branch: entry.find((line) => line.startsWith('branch '))?.slice('branch '.length) };
}

function realPathOf(path: string): string {
  if (existsSync(path)) return realpathSync(path);
  const parent = dirname(path);
  return parent === path ? path : join(realPathOf(parent), basename(path));
}
