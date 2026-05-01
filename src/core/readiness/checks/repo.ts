import type { ReadinessCheck } from '../types.js';

export interface RepoReadinessInput {
  isGitRepo: boolean;
  dirtyFiles: string[];
  untrackedFiles: string[];
  activeSession?: string | undefined;
  activeSessionLive?: boolean | undefined;
  requiresCleanWorktree?: boolean | undefined;
}

export function buildRepoChecks(repo: RepoReadinessInput): ReadinessCheck[] {
  if (!repo.isGitRepo) {
    return [{
      id: 'repo.not-git',
      severity: 'blocker',
      summary: 'Project is not a git repository.',
      fix: 'Run `git init` first or choose a project directory inside a git repository.',
      nextAction: 'clean-or-isolate-repo',
    }];
  }

  const checks: ReadinessCheck[] = [{
    id: 'repo.git',
    severity: 'ok',
    summary: 'Git repository detected.',
  }];

  if (repo.activeSession) {
    checks.push({
      id: repo.activeSessionLive ? 'repo.active-session-live' : 'repo.active-session-stale',
      severity: repo.activeSessionLive ? 'blocker' : 'info',
      summary: repo.activeSessionLive
        ? `Active session ${repo.activeSession} is still live.`
        : `Stale active session marker ${repo.activeSession} can be cleared.`,
      fix: repo.activeSessionLive
        ? 'Run `diptych resume` or clear .diptych/active after confirming the session is not live.'
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
      id: repo.requiresCleanWorktree ? 'repo.dirty-worktree-blocked' : 'repo.dirty-worktree',
      severity: repo.requiresCleanWorktree ? 'blocker' : 'warning',
      summary: `Working tree has ${dirtyCount} changed and ${untrackedCount} untracked file${untrackedCount === 1 ? '' : 's'}.`,
      details: examples.length > 0 ? [`Examples: ${examples.join(', ')}`] : undefined,
      fix: repo.requiresCleanWorktree
        ? 'Clean the source checkout before creating an isolated worktree.'
        : 'Review local edits before starting if they may overlap the requested change.',
      nextAction: repo.requiresCleanWorktree ? 'clean-or-isolate-repo' : undefined,
      metadata: { dirtyCount, untrackedCount },
    });
  }

  return checks;
}
