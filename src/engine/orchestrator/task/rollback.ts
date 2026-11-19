import type { Task } from '../../../core/schemas/task.js';
import { relative } from 'node:path';
import { replacedFilesSavedIn } from '../../../core/runtime/commands/messages.js';
import type { WorkflowState } from '../../../core/schemas/workflow/state.js';
import type { ChangedFilesSnapshot } from '../../../core/schemas/workflow/changed-files.js';
import { loadState } from '../../../core/state/persistence.js';
import { labelError } from '../../../utils/format/errors.js';
import { pluralize } from '../../../utils/pluralize.js';
import { publishWarning } from '../publish/notice.js';
import { publishWarningFromError } from '../publish/notice.js';
import { inferTaskOwnChangedFiles } from '../changed-files-baseline.js';
import type { WorkflowContext } from '../types.js';
import { restoreWorkspaceFiles } from '../isolation/entry-snapshot.js';
import { keptCheckoutPathsMessage } from '../isolation/checkout-entries.js';
import { briefKeptFiles } from '../kept-work.js';
import { replacedAttemptWrites } from './booking.js';

/** The restore path runs before a WorkflowContext exists on resume, so it asks for only what it reads. */
type RestoreContext = Pick<WorkflowContext, 'projectDir' | 'workspaceDir' | 'sessionId' | 'bus'>;

/** Takes the snapshot's files back and returns the warning that names them, or why it failed. */
async function restoreSnapshotFiles(opts: {
  wctx: RestoreContext;
  snapshot: ChangedFilesSnapshot;
  restoredMessage: (restoredFiles: string[], changes: string) => string;
  failureMessage: string;
}): Promise<string | undefined> {
  try {
    const { restoredFiles, keptPaths, savedTo } = await restoreWorkspaceFiles({
      ref: { projectDir: opts.wctx.projectDir, sessionId: opts.wctx.sessionId },
      dir: opts.wctx.workspaceDir,
      snapshot: opts.snapshot,
      files: undefined,
      checkout: loadState(opts.wctx)?.workspace?.kind === 'checkout',
    });
    const kept =
      keptPaths !== undefined && keptPaths.length > 0
        ? keptCheckoutPathsMessage(keptPaths)
        : undefined;
    if (restoredFiles.length === 0) return kept;
    const saved =
      savedTo === undefined
        ? ''
        : `. ${replacedFilesSavedIn(relative(opts.wctx.projectDir, savedTo))}`;
    const restored = `${opts.restoredMessage(restoredFiles, pluralize(restoredFiles.length, 'change'))}${saved}`;
    return kept === undefined ? restored : `${restored}. ${kept}`;
  } catch (err) {
    return labelError(opts.failureMessage, err);
  }
}

function publishRestoreWarning(
  wctx: RestoreContext,
  phase: WorkflowState['phase'],
  warning: string | undefined,
): void {
  if (warning !== undefined) publishWarning({ bus: wctx.bus, phase, message: warning });
}

/** The saved task snapshot carries the writes recorded since the caller read it. */
function savedTaskSnapshot(
  wctx: RestoreContext,
  taskStartSnapshot: ChangedFilesSnapshot,
): ChangedFilesSnapshot {
  return loadState(wctx)?.changedFilesBaseline?.activeTaskSnapshot ?? taskStartSnapshot;
}

/**
 * Every file the brief changed since its task-start snapshot, across all its attempts, goes back.
 * A rewritten brief or a split child starts from its own snapshot, so the files of the attempts it
 * replaced stay. The caller publishes the returned warning where its own events allow it, with
 * `briefKept`, the files a put-back of the brief still acts on afterwards.
 */
export async function restoreExhaustedTaskFiles(opts: {
  wctx: RestoreContext;
  taskStartSnapshot: ChangedFilesSnapshot;
}): Promise<{ message: string; briefKept: number | undefined } | undefined> {
  const snapshot = savedTaskSnapshot(opts.wctx, opts.taskStartSnapshot);
  const message = await restoreSnapshotFiles({
    wctx: opts.wctx,
    snapshot,
    restoredMessage: (restoredFiles, changes) =>
      `Restored ${restoredFiles.length} ${changes} of the failing brief to its start: ${restoredFiles.join(', ')}`,
    failureMessage: 'Failed to restore the changes of the failing brief to its start',
  });
  if (message === undefined) return undefined;
  return { message, briefKept: (await briefKeptFiles(opts.wctx.workspaceDir, snapshot))?.length };
}

export function restoreHookDeniedTaskFiles(opts: {
  wctx: RestoreContext;
  taskStartSnapshot: ChangedFilesSnapshot;
  hook: 'pre_task' | 'pre_validation';
}): Promise<string | undefined> {
  return restoreSnapshotFiles({
    wctx: opts.wctx,
    snapshot: savedTaskSnapshot(opts.wctx, opts.taskStartSnapshot),
    restoredMessage: (restoredFiles, changes) =>
      `Restored ${restoredFiles.length} unvalidated task ${changes} after ${opts.hook} denied: ${restoredFiles.join(', ')}`,
    failureMessage: `Failed to restore denied ${opts.hook} task changes`,
  });
}

/**
 * A skip that closes a lineage also takes back the attempts that a rewrite or a split replaced
 * (`replacedAttemptWrites`), newest first, so a file several of them wrote ends where the oldest
 * started. The caller publishes the returned warning.
 */
export async function restoreReplacedAttemptFiles(opts: {
  wctx: RestoreContext;
  state: WorkflowState;
  task: Task;
}): Promise<string | undefined> {
  const warnings: string[] = [];
  for (const snapshot of replacedAttemptWrites(opts.wctx, opts.state, opts.task)) {
    const warning = await restoreSnapshotFiles({
      wctx: opts.wctx,
      snapshot,
      restoredMessage: (restoredFiles, changes) =>
        `Restored ${restoredFiles.length} ${changes} of the attempts before the rewrite or split: ${restoredFiles.join(', ')}`,
      failureMessage: 'Failed to restore the changes of the attempts before the rewrite or split',
    });
    if (warning !== undefined) warnings.push(warning);
  }
  return warnings.length === 0 ? undefined : warnings.join('. ');
}

/**
 * The brief's own writes go back: the paths its calls recorded, its declared files and the files
 * the ledger records it promoted. A kill can cut a call before it records its writes; everything
 * else changed since the task-start snapshot is the operator's, made while no run was executing.
 */
export async function restoreInterruptedTaskFiles(opts: {
  wctx: RestoreContext;
  phase: WorkflowState['phase'];
  task: Task;
  taskStartSnapshot: ChangedFilesSnapshot;
}): Promise<void> {
  const { wctx, phase, task, taskStartSnapshot } = opts;
  const failureMessage = `Failed to restore ${task.id} from its task-start snapshot`;
  const checkout = loadState(wctx)?.workspace?.kind === 'checkout';
  let ownFiles: string[] = [];
  try {
    // A snapshot head the operator rewrote between the kill and the resume no
    // longer resolves; the run still restarts the brief.
    if (!checkout)
      ownFiles = await inferTaskOwnChangedFiles(
        wctx,
        task,
        taskStartSnapshot.head,
        wctx.workspaceDir,
        taskStartSnapshot,
      );
  } catch (err) {
    publishWarningFromError({ bus: wctx.bus, phase }, failureMessage, err);
    return;
  }
  const snapshot = savedTaskSnapshot(wctx, taskStartSnapshot);
  const warning = await restoreSnapshotFiles({
    wctx,
    snapshot: checkout
      ? { ...snapshot, restoreFiles: undefined }
      : {
          ...snapshot,
          restoreFiles: [...new Set([...(snapshot.restoreFiles ?? []), ...ownFiles])],
        },
    restoredMessage: (restoredFiles, changes) =>
      `Restored ${restoredFiles.length} unfinished ${changes} from the interrupted ${task.id}: ${restoredFiles.join(', ')}`,
    failureMessage,
  });
  publishRestoreWarning(wctx, phase, warning);
}
