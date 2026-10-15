import { countNoun } from '../../../utils/pluralize.js';
import type { InProgressGitOp } from '../../../lib/git/repository.js';
import type { IsolationStrategy } from '../../schemas/enums.js';
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

export const ACTIVE_SESSION_LIVE_CHECK = 'repo.active-session-live';

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
        fix: 'Make an initial commit (e.g. `git add -A && git commit -m init`) before starting a workflow.',
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
      id: repo.activeSessionLive ? ACTIVE_SESSION_LIVE_CHECK : 'repo.active-session-stale',
      severity: repo.activeSessionLive ? 'blocker' : 'info',
      summary: repo.activeSessionLive
        ? `Active session ${repo.activeSession} is still live.`
        : `Stale active session marker ${repo.activeSession} can be cleared.`,
      fix: repo.activeSessionLive
        ? 'Run `splitbrief resume` or clear .splitbrief/active after confirming the session is not live.'
        : undefined,
      nextAction: repo.activeSessionLive ? 'clean-or-isolate-repo' : undefined,
      metadata: { sessionId: repo.activeSession, live: repo.activeSessionLive === true },
    });
  }

  const dirtyCount = repo.dirtyFiles.length;
  const untrackedCount = repo.untrackedFiles.length;
  if (dirtyCount > 0 || untrackedCount > 0) {
    const examples = [...repo.dirtyFiles, ...repo.untrackedFiles].slice(0, 5);
    const inCheckout = isolation === 'none';
    checks.push({
      id: 'repo.dirty-worktree',
      severity: 'warning',
      summary: `Working tree has ${[
        ...(dirtyCount > 0 ? [countNoun(dirtyCount, 'changed file')] : []),
        ...(untrackedCount > 0 ? [countNoun(untrackedCount, 'untracked file')] : []),
      ].join(' and ')}.`,
      details: [
        ...(examples.length > 0 ? [`Examples: ${examples.join(', ')}`] : []),
        ...(inCheckout ? ['An attempt revert restores only the paths that attempt changed.'] : []),
      ],
      fix: inCheckout
        ? 'The run edits this checkout. Commit or stash the edits you do not want this run to touch. A revert saves the files it replaces in .splitbrief/sessions/<id>/reverted/.'
        : 'Review local edits if they may overlap the requested change.',
      metadata: { dirtyCount, untrackedCount },
    });
  }

  return checks;
}

/**
 * A read-only purpose starts nothing, claims no active pointer and writes no
 * session state, so a run in progress elsewhere cannot refuse it. The live
 * session is still worth reporting, so it is downgraded to the fact it is
 * rather than dropped.
 */
export function exemptLiveSessionBlocker(check: ReadinessCheck): ReadinessCheck {
  if (check.id !== ACTIVE_SESSION_LIVE_CHECK) return check;
  return {
    id: check.id,
    severity: 'info',
    summary: check.summary,
    ...(check.metadata !== undefined && { metadata: check.metadata }),
  };
}
