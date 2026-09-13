import type { Task } from '../../../core/schemas/task.js';
import type { ChangedFilesSnapshot, WorkflowState } from '../../../core/schemas/workflow.js';
import { publishWarning, publishWarningFromError } from '../events.js';
import { restoreDirtyFilesFromSnapshot } from '../approval/file-snapshots/restore.js';
import { inferTaskAcceptedChangedFiles } from '../changed-files-baseline.js';
import type { WorkflowContext } from '../types.js';

/** The restore path runs before a WorkflowContext exists on resume, so it asks for only what it reads. */
type RestoreContext = Pick<WorkflowContext, 'projectDir' | 'bus'>;

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
    const { restoredFiles } = await restoreDirtyFilesFromSnapshot(
      opts.wctx.projectDir,
      opts.taskStartSnapshot,
      opts.taskChangedFiles,
    );
    if (restoredFiles.length > 0) {
      publishWarning({
        bus: opts.wctx.bus,
        phase: opts.phase,
        message: opts.restoredMessage(restoredFiles),
      });
    }
  } catch (err) {
    publishWarningFromError({ bus: opts.wctx.bus, phase: opts.phase }, opts.failureMessage, err);
  }
}

export function restoreExhaustedTaskFiles(opts: {
  wctx: WorkflowContext;
  phase: WorkflowState['phase'];
  taskChangedFiles: string[];
  taskStartSnapshot: ChangedFilesSnapshot;
}): Promise<void> {
  return restoreTaskFilesFromSnapshot({
    ...opts,
    restoredMessage: (restoredFiles) =>
      `Restored ${restoredFiles.length} failing task change(s) to the pre-task state after recovery: ${restoredFiles.join(', ')}`,
    failureMessage: 'Failed to restore failing task changes from the pre-task snapshot',
  });
}

export function restoreDeniedPreValidationFiles(opts: {
  wctx: WorkflowContext;
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
 * Only the brief's own declared files go back: everything else changed since the
 * task-start snapshot is the operator's, made while no run was executing.
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
    taskChangedFiles = await inferTaskAcceptedChangedFiles(
      wctx.projectDir,
      task,
      taskStartSnapshot.head,
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
