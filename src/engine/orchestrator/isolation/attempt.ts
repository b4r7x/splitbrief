import { sessionDir } from '../../../core/paths.js';
import { getChangedFilesSinceSnapshot } from '../approval/file-snapshots/changed-since.js';
import { briefKeptFiles } from '../kept-work.js';
import { prepareWorktreeAcquisition } from './acquisition.js';
import { trackOperation } from './dispose.js';
import { captureWorkspaceSnapshot } from './entry-snapshot.js';
import { assertWorkspaceIdentity, open, saveRecord } from './open.js';
import { readWorkspaceRecord, retentionError } from './retention.js';
import {
  assertAttemptDir,
  queueCleanup,
  restoreAttempt,
  revertAttempt,
  settledCleanup,
} from './revert.js';
import type { AttemptWorkspace, RunIsolation, RunIsolationState } from './types.js';

export function acquire(
  state: RunIsolationState,
  input: Parameters<RunIsolation['acquire']>[0],
): Promise<AttemptWorkspace> {
  if (state.disposed) return Promise.reject(retentionError.unavailable());
  const operation = state.acquisitionQueue.then(() => acquireWorkspace(state, input));
  state.acquisitionQueue = operation.catch(() => undefined);
  return trackOperation(state, operation);
}

async function acquireWorkspace(
  state: RunIsolationState,
  input: Parameters<RunIsolation['acquire']>[0],
): Promise<AttemptWorkspace> {
  const { projectDir, sessionId, warningPublisher } = state.opts;
  const opened = await open(state, { config: input.config });
  const dir = opened.projectDir;
  const inCheckout = opened.kind === 'checkout';
  await settledCleanup(state);
  await assertAttemptDir(state, dir);
  if (state.disposed) throw retentionError.unavailable();
  const previous = inCheckout
    ? null
    : (state.retainedAttempt ?? (await readWorkspaceRecord({ projectDir, sessionId })));
  const retained = previous?.retained === true ? previous : null;
  if (retained !== null && input.resume !== true)
    await revertAttempt(state, dir, retained.snapshot, input.brief);
  const resumed = retained !== null && input.resume === true;
  const targetBaseline = inCheckout
    ? undefined
    : (
        await prepareWorktreeAcquisition({
          projectDir,
          sessionId,
          worktreeDir: dir,
          initialTargetBaseline: undefined,
          pinned: state.pinned,
        })
      ).targetBaseline;
  const snapshot = resumed
    ? retained.snapshot
    : await captureWorkspaceSnapshot(
        dir,
        { projectDir, sessionId },
        undefined,
        state.pinned ? null : projectDir,
      );
  const sandboxEnv = resumed
    ? await state.sandboxEnvs.resumedEnv(dir, input.role, input.config)
    : await state.sandboxEnvs.workspaceEnv(
        dir,
        input.role,
        input.config,
        inCheckout ? sessionDir(projectDir, sessionId) : dir,
      );
  await assertAttemptDir(state, dir);
  if (state.disposed) throw retentionError.unavailable();
  let preserved = false;
  const workspace: AttemptWorkspace = {
    projectDir: dir,
    sandboxEnv,
    snapshot,
    targetBaseline,
    changeDetection: 'file-hashes',
    changedFiles: () => getChangedFilesSinceSnapshot(dir, snapshot),
    cleanup: () => {
      if (state.disposed || preserved || state.ownedWorkspace !== workspace) return;
      queueCleanup(state, dir, snapshot, input.brief);
    },
    revert: async () => {
      if (state.disposed || state.ownedWorkspace !== workspace) throw retentionError.unavailable();
      await settledCleanup(state);
      return revertAttempt(state, dir, snapshot, input.brief);
    },
    discard: async (files) => {
      if (state.disposed || state.ownedWorkspace !== workspace) throw retentionError.unavailable();
      await settledCleanup(state);
      const { restoredFiles, savedTo } = await restoreAttempt(state, dir, snapshot, files);
      const kept = await briefKeptFiles(dir, input.brief.taskStartSnapshot);
      return { restoredFiles, savedTo, briefKept: kept?.length };
    },
    retain: () => {
      if (state.disposed || state.ownedWorkspace !== workspace)
        return Promise.reject(retentionError.unavailable());
      preserved = true;
      // A stopped call's partial stays in the checkout as it is; there is no record to keep.
      if (inCheckout) return Promise.resolve();
      return trackOperation(
        state,
        (async () => {
          try {
            await assertWorkspaceIdentity(state, dir);
            if (state.disposed || state.ownedWorkspace !== workspace)
              throw retentionError.unavailable();
            snapshot.restoreFiles ??= await getChangedFilesSinceSnapshot(dir, snapshot);
            await saveRecord(state, workspace, true);
          } catch (cause) {
            const failure = retentionError.failed(dir, cause);
            warningPublisher?.(failure.message);
            throw failure;
          }
        })(),
      );
    },
  };
  if (!inCheckout) await saveRecord(state, workspace, false);
  state.retainedAttempt = null;
  state.ownedWorkspace = workspace;
  return workspace;
}
