import { countNoun } from '../../../utils/pluralize.js';
import type { InProgressGitOp } from '../../../lib/git/repository.js';
import { revertedDir } from '../../paths.js';
import type { IsolationStrategy } from '../../schemas/enums.js';
import type { SessionRef } from '../../types/session-ref.js';
import type { ReadinessCheck } from '../types.js';

export interface RepoReadinessInput {
  isGitRepo: boolean;
  hasCommits: boolean;
  dirtyFiles: string[];
  untrackedFiles: string[];
  onDetachedHead?: boolean | undefined;
  inProgressGitOp?: InProgressGitOp | null | undefined;
  activeSession?: string | undefined;
  activeSessionLive?: boolean | undefined;
}

export const DIRTY_WORKTREE_CHECK = 'repo.dirty-worktree';

/** Before a run exists its folder has no name, so the fix names where the run's folder will be. */
function checkoutFix(run: SessionRef | undefined): string {
  const folder =
    run === undefined
      ? "the run's reverted/ folder, under .splitbrief/sessions/"
      : `${revertedDir(run)}/`;
  return `The run edits this checkout. A revert saves the files it replaces in ${folder}. Commit or stash the edits you do not want this run to touch.`;
}

export function buildRepoChecks(
  repo: RepoReadinessInput,
  isolation?: IsolationStrategy,
): ReadinessCheck[] {
  if (!repo.isGitRepo) {
    return [
      {
        id: 'repo.not-git',
        severity: 'blocker',
        summary: 'Project is not a git repository.',
        fix: 'Run `git init` first or choose a project directory inside a git repository.',
        nextAction: 'clean-or-isolate-repo',
      },
    ];
  }

  if (!repo.hasCommits) {
    return [
      {
        id: 'repo.no-commits',
        severity: 'blocker',
        summary: 'Git repository has no commits yet.',
        fix: 'Make a first commit of your files, then start again.',
        nextAction: 'clean-or-isolate-repo',
      },
    ];
  }

  const checks: ReadinessCheck[] = [
    {
      id: 'repo.git',
      severity: 'ok',
      summary: 'Git repository detected.',
    },
  ];

  if (repo.inProgressGitOp) {
    const abortCommand =
      repo.inProgressGitOp === 'bisect'
        ? 'git bisect reset'
        : `git ${repo.inProgressGitOp} --abort`;
    checks.push({
      id: 'repo.in-progress-git-op',
      severity: 'blocker',
      summary: `A git ${repo.inProgressGitOp} is in progress.`,
      fix: `Finish or abort the in-progress ${repo.inProgressGitOp} (e.g. \`${abortCommand}\`) before starting a workflow.`,
      nextAction: 'clean-or-isolate-repo',
      metadata: { operation: repo.inProgressGitOp },
    });
  }

  if (repo.onDetachedHead) {
    checks.push({
      id: 'repo.detached-head',
      severity: 'warning',
      summary: 'Repository is in a detached HEAD state.',
      details: [
        'The run leaves its changes uncommitted in your working tree; a commit you make on a detached HEAD belongs to no branch and is easy to lose.',
      ],
      fix: 'Check out a branch (e.g. `git switch -c splitbrief/work`) before you commit the changes.',
    });
  }

  if (repo.activeSession) {
    checks.push({
      id: repo.activeSessionLive ? 'repo.active-session-live' : 'repo.active-session-stale',
      severity: 'info',
      summary: repo.activeSessionLive
        ? `Run ${repo.activeSession} is still running.`
        : `Run ${repo.activeSession} is the default.`,
      metadata: { sessionId: repo.activeSession, live: repo.activeSessionLive === true },
    });
  }

  const dirtyCount = repo.dirtyFiles.length;
  const untrackedCount = repo.untrackedFiles.length;
  if (dirtyCount > 0 || untrackedCount > 0) {
    const examples = [...repo.dirtyFiles, ...repo.untrackedFiles].slice(0, 5);
    const inCheckout = isolation === 'none';
    checks.push({
      id: DIRTY_WORKTREE_CHECK,
      severity: 'warning',
      summary: `Working tree has ${[
        ...(dirtyCount > 0 ? [countNoun(dirtyCount, 'changed file')] : []),
        ...(untrackedCount > 0 ? [countNoun(untrackedCount, 'untracked file')] : []),
      ].join(' and ')}.`,
      details: [
        ...(examples.length > 0 ? [`Examples: ${examples.join(', ')}`] : []),
        ...(inCheckout
          ? ['A revert keeps shared changes and changes it cannot attribute to this run.']
          : []),
      ],
      fix: inCheckout
        ? checkoutFix(undefined)
        : 'Review local edits if they may overlap the requested change.',
      metadata: { dirtyCount, untrackedCount },
    });
  }

  return checks;
}

/** At run start the checkout warning names the run's own folder for the files a revert saves. */
export function withRunFolder(check: ReadinessCheck, run: SessionRef): ReadinessCheck {
  return check.fix === checkoutFix(undefined) ? { ...check, fix: checkoutFix(run) } : check;
}
