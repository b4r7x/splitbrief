import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { publishWarning, publishWarningFromError } from '../events.js';
import { restoreDirtyFilesFromSnapshot } from '../approval/file-snapshots/restore.js';
import type { ChangedFilesSnapshot } from '../approval/file-snapshots/types.js';
import type { WorkflowContext } from '../types.js';

async function restoreTaskFilesFromSnapshot(opts: {
  wctx: WorkflowContext;
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

export async function restoreExhaustedTaskFiles(opts: {
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

export async function restoreDeniedPreValidationFiles(opts: {
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
