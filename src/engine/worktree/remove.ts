import { existsSync } from 'node:fs';
import { SPLITBRIEF_IDENTITY } from '../../core/identity.js';
import type { GitClient } from '../../lib/git/client.js';
import { worktreeError } from './errors.js';
import {
  gitignoreDiffersOnlyBySplitbriefBookkeeping,
  shouldIgnoreWorktreeUncommittedPath,
} from './cleanliness.js';
import { resolveConfinedWorktreePath } from './path.js';
import { findLiveWorktreeSession } from './status.js';

export type RemoveWorktreeOptions = {
  projectDir: string;
  slug: string;
  git: GitClient;
  force?: boolean;
  deleteBranch?: boolean;
};

export async function removeWorktree(opts: RemoveWorktreeOptions): Promise<void> {
  const { projectDir, slug, git, force = false, deleteBranch = false } = opts;
  const wtPath = resolveConfinedWorktreePath(projectDir, slug);
  const branch = `${SPLITBRIEF_IDENTITY.branchPrefix}${slug}`;

  if (!existsSync(wtPath)) {
    const branches = await git.branch();
    if (!branches.all.includes(branch)) {
      throw worktreeError.notFound(slug);
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
      throw worktreeError.liveSession(slug, live.sessionId);
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
      throw worktreeError.uncommittedChanges(slug);
    }
    uncommittedBypassed = true;
  }

  if (liveSessionBypassed) {
    process.stderr.write(
      `Warning: forcing removal of worktree ".trees/${slug}" with live session ${liveSessionId ?? 'unknown'}.\n`,
    );
  }
  if (uncommittedBypassed) {
    process.stderr.write(
      `Warning: forcing removal of worktree ".trees/${slug}" with ${uncommittedFileCount} uncommitted file(s).\n`,
    );
  }

  await git.raw(['worktree', 'remove', wtPath, '--force']);

  if (deleteBranch) {
    await git.raw(['branch', '-D', branch]);
  }
}
