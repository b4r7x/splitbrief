import { relative } from 'node:path';
import { replacedFilesSavedIn } from '../../../core/runtime/commands/messages.js';
import type { ChangedFilesSnapshot } from '../../../core/schemas/workflow/changed-files.js';
import { warnError } from '../../../lib/warn.js';
import { toErrorMessage } from '../../../utils/format/errors.js';
import { countNoun } from '../../../utils/pluralize.js';
import { getChangedFilesSinceSnapshot } from '../approval/file-snapshots/changed-since.js';
import { restoreError } from '../approval/file-snapshots/restore.js';
import { briefKeptFiles } from '../kept-work.js';
import { keptCheckoutPathsMessage } from './checkout-entries.js';
import { restoreWorkspaceFiles } from './entry-snapshot.js';
import { attemptCleanupError } from './errors.js';
import { assertWorkspaceIdentity } from './open.js';
import type { AttemptBrief, AttemptRevertResult, RunIsolationState } from './types.js';

export async function assertAttemptDir(state: RunIsolationState, dir: string): Promise<void> {
  if (state.runWorkspace?.kind !== 'checkout') await assertWorkspaceIdentity(state, dir);
}

/** Puts the given files, or every file the attempt changed, back to the attempt's start. */
export async function restoreAttempt(
  state: RunIsolationState,
  dir: string,
  snapshot: ChangedFilesSnapshot,
  files?: readonly string[],
): Promise<AttemptRevertResult> {
  const { projectDir, sessionId } = state.opts;
  await assertAttemptDir(state, dir);
  const checkout = state.runWorkspace?.kind === 'checkout';
  if (!checkout) snapshot.restoreFiles ??= await getChangedFilesSinceSnapshot(dir, snapshot);
  const { restoredFiles, keptPaths, savedTo } = await restoreWorkspaceFiles({
    ref: { projectDir, sessionId },
    dir,
    snapshot,
    files,
    checkout,
  });
  if (keptPaths !== undefined && keptPaths.length > 0) {
    state.opts.warningPublisher?.(keptCheckoutPathsMessage(keptPaths));
  }
  return {
    restoredFiles,
    keptPaths: keptPaths ?? [],
    savedTo: savedTo === undefined ? undefined : relative(projectDir, savedTo),
  };
}

/**
 * Puts the attempt back and publishes its revert row. The row counts the files a put-back of the
 * brief still acts on, which an earlier attempt of the brief left.
 */
export async function revertAttempt(
  state: RunIsolationState,
  dir: string,
  snapshot: ChangedFilesSnapshot,
  brief: AttemptBrief,
): Promise<AttemptRevertResult> {
  const result = await restoreAttempt(state, dir, snapshot);
  const { restoredFiles, savedTo } = result;
  if (restoredFiles.length === 0) return result;
  const reverted = `${brief.task.id} attempt reverted: ${countNoun(restoredFiles.length, 'file')}`;
  const message =
    savedTo === undefined ? reverted : `${reverted}. ${replacedFilesSavedIn(savedTo)}.`;
  const kept = await briefKeptFiles(dir, brief.taskStartSnapshot);
  state.opts.infoPublisher?.({ message, briefKept: kept?.length });
  return result;
}

export function queueCleanup(
  state: RunIsolationState,
  dir: string,
  snapshot: ChangedFilesSnapshot,
  brief: AttemptBrief,
): void {
  state.pendingCleanup = state.pendingCleanup
    .then(async () => {
      await revertAttempt(state, dir, snapshot, brief);
    })
    .catch((err) => {
      state.cleanupFailure ??= attemptCleanupError.failed(dir, err);
      warnError(`Could not undo the attempt's changes in ${dir}`, err);
      if (restoreError.isStoreCorrupt(err)) state.opts.warningPublisher?.(toErrorMessage(err));
    });
}

export async function settledCleanup(state: RunIsolationState): Promise<void> {
  await state.pendingCleanup;
  if (state.cleanupFailure !== undefined) throw state.cleanupFailure;
}
