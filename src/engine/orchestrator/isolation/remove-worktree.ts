import { existsSync } from 'node:fs';
import { rm, rmdir } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import { SPLITBRIEF_IDENTITY } from '../../../core/identity.js';
import { createGitClient, type GitClient } from '../../../lib/git/client.js';
import { isENOENT, isNodeError } from '../../../lib/process/errors.js';
import { clearWorkspaceRecord, stagedWorkspaceRoot, retentionError } from './retention.js';
import { isInsideRoot } from '../../../lib/path-confinement.js';
import { worktreeError } from './errors.js';
import {
  gitignoreDiffersOnlyBySplitbriefBookkeeping,
  shouldIgnoreWorktreeUncommittedPath,
} from './cleanliness.js';
import { resolveConfinedWorktreePath } from './path.js';
import { findLiveWorktreeSession } from './worktree-status.js';

export type WorktreeWarningPublisher = (message: string) => void;

export type RemoveWorktreeOptions = {
  projectDir: string;
  slug: string;
  git: GitClient;
  deleteBranch?: boolean;
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

export async function removeRunWorkspace(
  projectDir: string,
  sessionId: string,
  workspace: { kind: 'worktree' | 'staged-copy' | 'checkout'; path: string },
): Promise<void> {
  if (workspace.kind === 'checkout') return;
  if (workspace.kind === 'worktree') {
    await removeWorktree({
      projectDir,
      slug: basename(workspace.path),
      git: createGitClient(projectDir),
      deleteBranch: true,
      worktreeDir: workspace.path,
      suppressUncommittedWarning: true,
    });
    await removeEmptyRepositoryRoot(workspace.path);
  } else {
    const root = dirname(workspace.path);
    if (
      root !== stagedWorkspaceRoot({ projectDir, sessionId }, basename(root)) ||
      workspace.path !== join(root, 'workspace')
    )
      throw retentionError.unavailable();
    await rm(root, { recursive: true, force: true });
  }
  clearWorkspaceRecord({ projectDir, sessionId });
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
  const {
    projectDir,
    slug,
    git,
    deleteBranch = false,
    warningPublisher,
    suppressUncommittedWarning = false,
  } = opts;
  const wtPath = opts.worktreeDir ?? resolveConfinedWorktreePath(projectDir, slug);
  const label = worktreeLabel(projectDir, wtPath);
  const branch = `${SPLITBRIEF_IDENTITY.branchPrefix}${slug}`;

  if (!existsSync(wtPath)) {
    const branches = await git.branch();
    if (!branches.all.includes(branch)) {
      throw worktreeError.notFound(label);
    }
    await git.raw(['worktree', 'prune']);
    if (deleteBranch) {
      await git.raw(['branch', '-D', branch]);
    }
    return;
  }

  const live = await findLiveWorktreeSession(wtPath);

  const porcelain = await git.raw(['-C', wtPath, 'status', '--porcelain']);
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
      `Warning: forcing removal of worktree "${label}" with ${uncommittedPaths.length} uncommitted file(s).`,
      warningPublisher,
    );
  }

  await git.raw(['worktree', 'remove', wtPath, '--force']);

  if (deleteBranch) {
    await git.raw(['branch', '-D', branch]);
  }
}
