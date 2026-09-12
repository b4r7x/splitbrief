import { pluralize } from '../../../utils/pluralize.js';
import type { InProgressGitOp } from '../../../lib/git/repository.js';
import type { CommitStrategy } from '../../schemas/enums.js';
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
  committerIdentityConfigured?: boolean | undefined;
  commitStrategy?: CommitStrategy | undefined;
}

export const ACTIVE_SESSION_LIVE_CHECK = 'repo.active-session-live';

export function buildRepoChecks(repo: RepoReadinessInput): ReadinessCheck[] {
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
      details: ['Per-task commits will not be on any branch and can be lost.'],
      fix: 'Check out a branch (e.g. `git switch -c splitbrief/work`) before starting a workflow.',
    });
  }

  if (
    repo.committerIdentityConfigured === false &&
    repo.commitStrategy !== undefined &&
    repo.commitStrategy !== 'none'
  ) {
    checks.push({
      id: 'repo.git-identity-missing',
      severity: 'warning',
      summary: 'Git identity not configured — per-task commits/checkpoints will fail.',
      fix: 'Set a git identity (e.g. `git config user.name "you"` and `git config user.email "you@example.com"`) before starting a workflow.',
      metadata: { commitStrategy: repo.commitStrategy },
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
    checks.push({
      id: 'repo.dirty-worktree',
      severity: 'warning',
      summary: `Working tree has ${dirtyCount} changed and ${untrackedCount} untracked ${pluralize(untrackedCount, 'file')}.`,
      details: examples.length > 0 ? [`Examples: ${examples.join(', ')}`] : undefined,
      fix: 'Review local edits before starting if they may overlap the requested change.',
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
