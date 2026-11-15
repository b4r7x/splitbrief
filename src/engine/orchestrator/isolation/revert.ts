import { relative } from 'node:path';
import { replacedFilesSavedIn } from '../../../core/runtime/commands/messages.js';
import type { ChangedFilesSnapshot } from '../../../core/schemas/workflow/changed-files.js';
import { warnError } from '../../../lib/warn.js';
import { countNoun } from '../../../utils/pluralize.js';
import { getChangedFilesSinceSnapshot } from '../approval/file-snapshots/changed-since.js';
import { briefKeptFiles } from '../kept-work.js';
import { restoreWorkspaceFiles } from './entry-snapshot.js';
import { attemptCleanupError } from './errors.js';
import { assertWorkspaceIdentity } from './open.js';
import type { AttemptBrief, RunIsolationState } from './types.js';

export async function assertAttemptDir(state: RunIsolationState, dir: string): Promise<void> {
  if (state.runWorkspace?.kind !== 'checkout') await assertWorkspaceIdentity(state, dir);
}

/** Puts the given files, or every file the attempt changed, back to the attempt's start. */
export async function restoreAttempt(
  state: RunIsolationState,
  dir: string,
  snapshot: ChangedFilesSnapshot,
  files?: readonly string[],
): Promise<{ restoredFiles: string[]; savedTo?: string | undefined }> {
  const { projectDir, sessionId } = state.opts;
  await assertAttemptDir(state, dir);
  snapshot.restoreFiles ??= await getChangedFilesSinceSnapshot(dir, snapshot);
  const { restoredFiles, savedTo } = await restoreWorkspaceFiles({
    ref: { projectDir, sessionId },
    dir,
    snapshot,
    files,
  });
  return {
    restoredFiles,
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
): Promise<void> {
  const { restoredFiles, savedTo } = await restoreAttempt(state, dir, snapshot);
  if (restoredFiles.length === 0) return;
  const reverted = `${brief.task.id} attempt reverted: ${countNoun(restoredFiles.length, 'file')}`;
  const message =
    savedTo === undefined ? reverted : `${reverted}. ${replacedFilesSavedIn(savedTo)}.`;
  const kept = await briefKeptFiles(dir, brief.taskStartSnapshot);
  state.opts.infoPublisher?.({ message, briefKept: kept?.length });
}

export function queueCleanup(
  state: RunIsolationState,
  dir: string,
  snapshot: ChangedFilesSnapshot,
  brief: AttemptBrief,
): void {
  state.pendingCleanup = state.pendingCleanup
    .then(() => revertAttempt(state, dir, snapshot, brief))
    .catch((err) => {
      state.cleanupFailure ??= attemptCleanupError.failed(dir, err);
      warnError(`Could not undo the attempt's changes in ${dir}`, err);
    });
}

export async function settledCleanup(state: RunIsolationState): Promise<void> {
  await state.pendingCleanup;
  if (state.cleanupFailure !== undefined) throw state.cleanupFailure;
}
