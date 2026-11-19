import { basename, join } from 'node:path';
import { sessionDir } from '../../../core/paths.js';
import { warnError } from '../../../lib/warn.js';
import { pruneSandboxNpmCache } from '../../runners/sandbox/env.js';
import { clearBridgedCliState } from '../../runners/sandbox/state/bridge.js';
import { removeSandboxTempDirs } from '../../runners/sandbox/state/paths.js';
import { stagedWorkspaceRoot, workspaceIdentityMatches } from './retention.js';
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
    const checkoutSandbox = sessionDir(projectDir, sessionId);
    await clearBridgedCliState(checkoutSandbox).catch((err: unknown) => {
      warnError('Could not remove the run’s tool sign-in copies', err);
    });
    await pruneSandboxNpmCache(checkoutSandbox);
    removeSandboxTempDirs(checkoutSandbox);
    const { worktree, location } = state;
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
    // A stopped run keeps its workspace whole for Continue, and a replaced directory is not the run's.
    if (location?.kind === 'staged-copy' && !state.retained) {
      const staged = join(
        stagedWorkspaceRoot({ projectDir, sessionId }, location.leaf),
        'workspace',
      );
      if (await workspaceIdentityMatches(state, staged)) await clearBridgedCliState(staged);
      removeSandboxTempDirs(staged);
    }
  } finally {
    state.removeWorkspaceRoot?.();
    await state.sandboxEnvs.removeResumedRoots();
    if (state.nodeModulesExcludeFile !== null)
      await removeNodeModulesExclude(state.nodeModulesExcludeFile, sessionId);
  }
}
