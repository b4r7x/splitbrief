import { afterEach, beforeEach } from 'vitest';
import { cleanupTempDir, createTempDir } from './temp-dir.js';
import { startWorkspaceRun } from './workspace-run.js';

export const CLOSE_RUN_SESSION_ID = '2026-10-04-close-run';

export function setupCloseRunWorkspace(): {
  dirs: string[];
  openWorkspaceRun: (strategy: 'worktree' | 'staged-copy') => ReturnType<typeof startWorkspaceRun>;
} {
  const realStateHome = process.env.XDG_STATE_HOME;
  const dirs: string[] = [];

  beforeEach(() => {
    const stateHome = createTempDir('close-run-state-home');
    dirs.push(stateHome);
    process.env.XDG_STATE_HOME = stateHome;
  });

  afterEach(() => {
    if (realStateHome === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = realStateHome;
    for (const dir of dirs.splice(0)) cleanupTempDir(dir);
  });

  return {
    dirs,
    openWorkspaceRun: (strategy) =>
      startWorkspaceRun({ strategy, sessionId: CLOSE_RUN_SESSION_ID, dirs }),
  };
}
