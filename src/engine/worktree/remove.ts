import { existsSync } from 'node:fs';
import { relative } from 'node:path';
import { SPLITBRIEF_IDENTITY } from '../../core/identity.js';
import type { GitClient } from '../../lib/git/client.js';
import { isInsideRoot } from '../../lib/path-confinement.js';
import { worktreeError } from './errors.js';
import {
  gitignoreDiffersOnlyBySplitbriefBookkeeping,
  shouldIgnoreWorktreeUncommittedPath,
} from './cleanliness.js';
import { resolveConfinedWorktreePath } from './path.js';
import { findLiveWorktreeSession } from './status.js';

export type WorktreeWarningPublisher = (message: string) => void;

export type RemoveWorktreeOptions = {
  projectDir: string;
  slug: string;
  git: GitClient;
  force?: boolean;
  deleteBranch?: boolean;
  // Run isolation places its worktree outside `.trees/` and resolves that path
  // itself; without it the slug names a directory under the project root.
  worktreeDir?: string;
  warningPublisher?: WorktreeWarningPublisher;
  // Isolation dispose proves no unpromoted work before force-removing; git
  // porcelain can still list promoted edits, so skip that bypass warning.
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
    force = false,
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

  let liveSessionBypassed = false;
  let uncommittedBypassed = false;
  let liveSessionId: string | null = null;
  let uncommittedFileCount = 0;

  const live = await findLiveWorktreeSession(wtPath);
  if (live) {
    if (!force) {
      throw worktreeError.liveSession(label, live.sessionId);
    }
    liveSessionBypassed = true;
    liveSessionId = live.sessionId;
  }

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
  if (uncommittedPaths.length > 0) {
    uncommittedFileCount = uncommittedPaths.length;
    if (!force) {
      throw worktreeError.uncommittedChanges(label);
    }
    uncommittedBypassed = true;
  }

  if (liveSessionBypassed) {
    publishWorktreeWarning(
      `Warning: forcing removal of worktree "${label}" with live session ${liveSessionId ?? 'unknown'}.`,
      warningPublisher,
    );
  }
  if (uncommittedBypassed && !suppressUncommittedWarning) {
    publishWorktreeWarning(
      `Warning: forcing removal of worktree "${label}" with ${uncommittedFileCount} uncommitted file(s).`,
      warningPublisher,
    );
  }

  await git.raw(['worktree', 'remove', wtPath, '--force']);

  if (deleteBranch) {
    await git.raw(['branch', '-D', branch]);
  }
}
