import { basename } from 'node:path';
import { pruneSandboxNpmCache } from '../../runners/sandbox/env.js';
import { clearBridgedCliState } from '../../runners/sandbox/state/bridge.js';
import { removeSandboxTempDirs } from '../../runners/sandbox/state/paths.js';
import type { RunIsolationState } from './types.js';
import { removeNodeModulesExclude } from './worktree/node-modules.js';
import { removeWorktree } from './worktree/remove.js';

export function trackOperation<T>(state: RunIsolationState, operation: Promise<T>): Promise<T> {
  state.inFlightOperations.add(operation);
  const settle = (): void => {
    state.inFlightOperations.delete(operation);
  };
  void operation.then(settle, settle);
  return operation;
}

async function waitForInFlightOperations(state: RunIsolationState): Promise<void> {
  while (state.inFlightOperations.size > 0) {
    await Promise.allSettled([...state.inFlightOperations]);
  }
}

export function dispose(state: RunIsolationState): Promise<void> {
  if (state.disposePromise === undefined) {
    state.disposed = true;
    state.disposePromise = disposeWorkspace(state);
  }
  return state.disposePromise;
}

async function disposeWorkspace(state: RunIsolationState): Promise<void> {
  const { projectDir, sessionId, warningPublisher } = state.opts;
  try {
    await waitForInFlightOperations(state);
    await state.pendingCleanup;
    await pruneSandboxNpmCache(projectDir);
    removeSandboxTempDirs(projectDir);
    const { worktree } = state;
    if (worktree !== null) {
      await clearBridgedCliState(worktree.dir);
      removeSandboxTempDirs(worktree.dir);
      if (worktree.abandoned) {
        await removeWorktree({
          projectDir,
          slug: basename(worktree.dir),
          git: worktree.git,
          worktreeDir: worktree.dir,
          ...(warningPublisher !== undefined && { warningPublisher }),
          suppressUncommittedWarning: true,
        });
      }
    }
  } finally {
    state.removeWorkspaceRoot?.();
    await state.sandboxEnvs.removeResumedRoots();
    if (state.nodeModulesExcludeFile !== null)
      await removeNodeModulesExclude(state.nodeModulesExcludeFile, sessionId);
  }
}
