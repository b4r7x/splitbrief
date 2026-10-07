import type { Task } from '../../../core/schemas/task.js';
import { relative } from 'node:path';
import type { ChangedFilesSnapshot, WorkflowState } from '../../../core/schemas/workflow.js';
import { publishWarning, publishWarningFromError } from '../events.js';
import { getChangedFilesSinceSnapshot } from '../approval/file-snapshots/capture.js';
import { inferTaskOwnChangedFiles } from '../changed-files-baseline.js';
import type { WorkflowContext } from '../types.js';
import { restoreWorkspaceFiles } from '../isolation/entry-snapshot.js';

/** The restore path runs before a WorkflowContext exists on resume, so it asks for only what it reads. */
type RestoreContext = Pick<WorkflowContext, 'projectDir' | 'workspaceDir' | 'sessionId' | 'bus'>;

async function restoreTaskFilesFromSnapshot(opts: {
  wctx: RestoreContext;
  phase: WorkflowState['phase'];
  taskChangedFiles: string[];
  taskStartSnapshot: ChangedFilesSnapshot;
  restoredMessage: (restoredFiles: string[]) => string;
  failureMessage: string;
}): Promise<void> {
  if (opts.taskChangedFiles.length === 0) return;
  try {
    const { restoredFiles, savedTo } = await restoreWorkspaceFiles({
      ref: { projectDir: opts.wctx.projectDir, sessionId: opts.wctx.sessionId },
      dir: opts.wctx.workspaceDir,
      snapshot: opts.taskStartSnapshot,
      files: opts.taskChangedFiles,
    });
    if (restoredFiles.length > 0) {
      const saved =
        savedTo === undefined
          ? ''
          : `. The replaced bytes are in ${relative(opts.wctx.projectDir, savedTo)}`;
      publishWarning({
        bus: opts.wctx.bus,
        phase: opts.phase,
        message: `${opts.restoredMessage(restoredFiles)}${saved}`,
      });
    }
  } catch (err) {
    publishWarningFromError({ bus: opts.wctx.bus, phase: opts.phase }, opts.failureMessage, err);
  }
}

/** Every file changed since `snapshot` returns to what it held then. */
async function restoreChangesSinceSnapshot(opts: {
  wctx: RestoreContext;
  phase: WorkflowState['phase'];
  snapshot: ChangedFilesSnapshot;
  listFailureMessage: string;
  restoredMessage: (restoredFiles: string[]) => string;
  failureMessage: string;
}): Promise<void> {
  let changedFiles: string[];
  try {
    changedFiles = await getChangedFilesSinceSnapshot(opts.wctx.workspaceDir, opts.snapshot);
  } catch (err) {
    publishWarningFromError(
      { bus: opts.wctx.bus, phase: opts.phase },
      opts.listFailureMessage,
      err,
    );
    return;
  }
  await restoreTaskFilesFromSnapshot({
    wctx: opts.wctx,
    phase: opts.phase,
    taskChangedFiles: changedFiles,
    taskStartSnapshot: opts.snapshot,
    restoredMessage: opts.restoredMessage,
    failureMessage: opts.failureMessage,
  });
}

/** Every file the brief changed since its task-start snapshot, across all its attempts, goes back. */
export function restoreExhaustedTaskFiles(opts: {
  wctx: RestoreContext;
  phase: WorkflowState['phase'];
  taskStartSnapshot: ChangedFilesSnapshot;
}): Promise<void> {
  return restoreChangesSinceSnapshot({
    wctx: opts.wctx,
    phase: opts.phase,
    snapshot: opts.taskStartSnapshot,
    listFailureMessage: 'Failed to list the failing task changes for rollback',
    restoredMessage: (restoredFiles) =>
      `Restored ${restoredFiles.length} failing task change(s) to the pre-task state after recovery: ${restoredFiles.join(', ')}`,
    failureMessage: 'Failed to restore failing task changes from the pre-task snapshot',
  });
}

export function restoreDeniedPreValidationFiles(opts: {
  wctx: RestoreContext;
  phase: WorkflowState['phase'];
  taskChangedFiles: string[];
  taskStartSnapshot: ChangedFilesSnapshot;
}): Promise<void> {
  return restoreTaskFilesFromSnapshot({
    ...opts,
    restoredMessage: (restoredFiles) =>
      `Restored ${restoredFiles.length} unvalidated task change(s) after pre_validation denied: ${restoredFiles.join(', ')}`,
    failureMessage: 'Failed to restore denied pre_validation task changes',
  });
}

/**
 * The current attempt's own writes go back: every file changed since the attempt's own start
 * snapshot returns to what it held then, so earlier attempts and earlier briefs keep their
 * results.
 */
export function restoreAttemptFiles(opts: {
  wctx: RestoreContext;
  phase: WorkflowState['phase'];
  attemptSnapshot: ChangedFilesSnapshot;
}): Promise<void> {
  return restoreChangesSinceSnapshot({
    wctx: opts.wctx,
    phase: opts.phase,
    snapshot: opts.attemptSnapshot,
    listFailureMessage: 'Failed to list the attempt changes for rollback',
    restoredMessage: (restoredFiles) =>
      `Restored ${restoredFiles.length} change(s) from the failed attempt: ${restoredFiles.join(', ')}`,
    failureMessage: 'Failed to restore the failed attempt changes from its start snapshot',
  });
}

/**
 * Only the brief's own writes go back — its declared files and the files the ledger records it
 * promoted: everything else changed since the task-start snapshot is the operator's, made while
 * no run was executing.
 */
export async function restoreInterruptedTaskFiles(opts: {
  wctx: RestoreContext;
  phase: WorkflowState['phase'];
  task: Task;
  taskStartSnapshot: ChangedFilesSnapshot;
}): Promise<void> {
  const { wctx, phase, task, taskStartSnapshot } = opts;
  const failureMessage = `Failed to restore ${task.id} from its task-start snapshot`;
  let taskChangedFiles: string[];
  try {
    // A snapshot head the operator rewrote between the kill and the resume no
    // longer resolves; the run still restarts the brief.
    taskChangedFiles = await inferTaskOwnChangedFiles(
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
  await restoreTaskFilesFromSnapshot({
    wctx,
    phase,
    taskChangedFiles,
    taskStartSnapshot,
    restoredMessage: (restoredFiles) =>
      `Restored ${restoredFiles.length} unfinished change(s) from the interrupted ${task.id}: ${restoredFiles.join(', ')}`,
    failureMessage,
  });
}
