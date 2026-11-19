import { acquire } from './attempt.js';
import { dispose } from './dispose.js';
import { open } from './open.js';
import { createWorkspaceSandboxEnvs } from './sandbox-env.js';
import type { RunIsolation, RunIsolationOptions, RunIsolationState } from './types.js';

export function createRunIsolation(opts: RunIsolationOptions): RunIsolation {
  const state: RunIsolationState = {
    opts,
    sandboxEnvs: createWorkspaceSandboxEnvs(),
    inFlightOperations: new Set(),
    fallbackReported: false,
    pinned: false,
    worktree: null,
    nodeModulesExcludeFile: null,
    runWorkspace: undefined,
    removeWorkspaceRoot: undefined,
    location: undefined,
    directory: undefined,
    owner: undefined,
    retainedAttempt: null,
    retained: false,
    ownedWorkspace: undefined,
    openPromise: undefined,
    disposePromise: undefined,
    acquisitionQueue: Promise.resolve(),
    pendingCleanup: Promise.resolve(),
    cleanupFailure: undefined,
    disposed: false,
  };
  return {
    open: (input) => open(state, input),
    acquire: (input) => acquire(state, input),
    dispose: () => dispose(state),
  };
}
