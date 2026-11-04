import type { Task } from '../../../core/schemas/task.js';
import { relative } from 'node:path';
import type { ChangedFilesSnapshot, WorkflowState } from '../../../core/schemas/workflow.js';
import { loadState } from '../../../core/state/persistence.js';
import { labelError } from '../../../utils/format-errors.js';
import { pluralize } from '../../../utils/pluralize.js';
import { publishWarning, publishWarningFromError } from '../events.js';
import { inferTaskOwnChangedFiles } from '../changed-files-baseline.js';
import type { WorkflowContext } from '../types.js';
import { restoreWorkspaceFiles } from '../isolation/entry-snapshot.js';
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
    const { restoredFiles, savedTo } = await restoreWorkspaceFiles({
      ref: { projectDir: opts.wctx.projectDir, sessionId: opts.wctx.sessionId },
      dir: opts.wctx.workspaceDir,
      snapshot: opts.snapshot,
      files: undefined,
    });
    if (restoredFiles.length === 0) return undefined;
    const saved =
      savedTo === undefined
        ? ''
        : `. The replaced bytes are in ${relative(opts.wctx.projectDir, savedTo)}`;
    return `${opts.restoredMessage(restoredFiles, pluralize(restoredFiles.length, 'change'))}${saved}`;
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

function restoreTaskFilesFromSnapshot(
  opts: Omit<Parameters<typeof restoreSnapshotFiles>[0], 'snapshot'> & {
    taskStartSnapshot: ChangedFilesSnapshot;
  },
): Promise<string | undefined> {
  return restoreSnapshotFiles({
    ...opts,
    snapshot: savedTaskSnapshot(opts.wctx, opts.taskStartSnapshot),
  });
}

/**
 * Every file the brief changed since its task-start snapshot, across all its attempts, goes back.
 * A rewritten brief or a split child starts from its own snapshot, so the files of the attempts it
 * replaced stay. The caller publishes the returned warning where its own events allow it.
 */
export function restoreExhaustedTaskFiles(opts: {
  wctx: RestoreContext;
  taskStartSnapshot: ChangedFilesSnapshot;
}): Promise<string | undefined> {
  return restoreTaskFilesFromSnapshot({
    wctx: opts.wctx,
    taskStartSnapshot: opts.taskStartSnapshot,
    restoredMessage: (restoredFiles, changes) =>
      `Restored ${restoredFiles.length} ${changes} of the failing brief to its start: ${restoredFiles.join(', ')}`,
    failureMessage: 'Failed to restore the changes of the failing brief to its start',
  });
}

export function restoreHookDeniedTaskFiles(opts: {
  wctx: RestoreContext;
  taskStartSnapshot: ChangedFilesSnapshot;
  hook: 'pre_task' | 'pre_validation';
}): Promise<string | undefined> {
  return restoreTaskFilesFromSnapshot({
    wctx: opts.wctx,
    taskStartSnapshot: opts.taskStartSnapshot,
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
  let ownFiles: string[];
  try {
    // A snapshot head the operator rewrote between the kill and the resume no
    // longer resolves; the run still restarts the brief.
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
    snapshot: {
      ...snapshot,
      restoreFiles: [...new Set([...(snapshot.restoreFiles ?? []), ...ownFiles])],
    },
    restoredMessage: (restoredFiles, changes) =>
      `Restored ${restoredFiles.length} unfinished ${changes} from the interrupted ${task.id}: ${restoredFiles.join(', ')}`,
    failureMessage,
  });
  publishRestoreWarning(wctx, phase, warning);
}
