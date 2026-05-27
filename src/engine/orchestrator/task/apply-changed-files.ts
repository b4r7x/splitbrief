import type { Task } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { WorkflowContext } from '../types.js';
import { toErrorMessage } from '../../../utils/format-errors.js';
import { publishError, publishWarning, publishWarningFromError } from '../events.js';
import { gateChangedFiles, type GateChangedFilesDecision } from '../approval/gate-files.js';
import {
  captureCurrentFileContents,
  getChangedFilesSinceSnapshot,
  restoreDirtyFilesFromSnapshot,
  type ChangedFilesSnapshot,
} from '../approval/file-snapshots.js';
import { promoteStagedChanges, type StagedProject } from '../approval/staged-project.js';
import type { GateDecision } from '../approval/tiered-approval.js';
import { persistApprovalEvidence } from '../evidence/persistence.js';
import { resolveDependsOnFiles } from './resolve-deps.js';

export type ApplyChangedFilesResult =
  | { proceed: true; state: WorkflowState; taskChangedFiles: string[] }
  | { proceed: false; state: WorkflowState };

export async function applyChangedFiles(opts: {
  wctx: WorkflowContext;
  task: Task;
  state: WorkflowState;
  staged: StagedProject | undefined;
  usesStaging: boolean;
  preApplyApprovedFiles: string[];
  taskStartSnapshot: ChangedFilesSnapshot;
  recordApprovalDenial: (state: WorkflowState, decision: GateDecision, message: string) => void;
  handleConflict: (state: WorkflowState, files: string[]) => Promise<WorkflowState>;
}): Promise<ApplyChangedFilesResult> {
  const { wctx, task, staged, usesStaging, preApplyApprovedFiles, taskStartSnapshot } = opts;
  const { projectDir, sessionId, config, callbacks } = wctx;
  let state = opts.state;

  let taskChangedFiles: string[];
  let taskChangedFilesFromStaging = Boolean(staged);
  try {
    taskChangedFiles = await getChangedFilesSinceSnapshot(staged?.projectDir ?? projectDir, taskStartSnapshot);
    if (usesStaging && taskChangedFiles.length === 0) {
      taskChangedFiles = await getChangedFilesSinceSnapshot(projectDir, taskStartSnapshot);
      taskChangedFilesFromStaging = false;
    }
  } catch (err) {
    staged?.cleanup();
    publishError({ bus: wctx.bus, phase: state.phase }, `Task changed files blocked by approval gate: ${toErrorMessage(err)}`);
    return { proceed: false, state };
  }

  const preApprovalChangedFileContents = await captureCurrentFileContents(projectDir, taskChangedFiles);
  const preApplyApprovedFileSet = new Set(preApplyApprovedFiles);
  const filesNeedingApproval = taskChangedFiles.filter((file) => !preApplyApprovedFileSet.has(file));
  let changedFilesGate: GateChangedFilesDecision = { allow: true, changedFiles: taskChangedFiles };
  if (filesNeedingApproval.length > 0) {
    changedFilesGate = await gateChangedFiles({
      changedFiles: filesNeedingApproval,
      task,
      dependsOnFiles: resolveDependsOnFiles(state.tasks, task),
      projectDir,
      sessionId,
      phase: state.phase,
      taskId: task.id,
      bus: wctx.bus,
      callbacks,
      config,
    });
  }

  if (!changedFilesGate.allow) {
    const files = changedFilesGate.changedFiles.join(', ');
    try {
      if (!taskChangedFilesFromStaging) {
        const restoreResult = await restoreDirtyFilesFromSnapshot(
          projectDir,
          taskStartSnapshot,
          changedFilesGate.changedFiles,
          preApprovalChangedFileContents,
        );
        if (restoreResult.conflictedFiles.length > 0) {
          state = await opts.handleConflict(state, restoreResult.conflictedFiles);
          publishWarning({ bus: wctx.bus, phase: state.phase },
            `denied task rollback skipped files changed during approval: ${restoreResult.conflictedFiles.join(', ')}`,
          );
        }
      }
    } catch (err) {
      publishWarningFromError({ bus: wctx.bus, phase: state.phase }, 'failed to discard denied task changes', err);
    }
    staged?.cleanup();
    opts.recordApprovalDenial(
      state,
      changedFilesGate,
      `Task changed files blocked by approval gate: ${changedFilesGate.reason ?? 'denied'} (${files})`,
    );
    return { proceed: false, state };
  }

  if (filesNeedingApproval.length > 0) {
    persistApprovalEvidence(wctx, state, changedFilesGate, task.id);
  }

  if (staged) {
    const promoteResult = await promoteStagedChanges(projectDir, staged.projectDir, taskChangedFiles, preApprovalChangedFileContents);
    staged.cleanup();
    if (promoteResult.conflictedFiles.length > 0) {
      state = await opts.handleConflict(state, promoteResult.conflictedFiles);
      publishError({ bus: wctx.bus, phase: state.phase },
        `Approved task promotion blocked because files changed during approval: ${promoteResult.conflictedFiles.join(', ')}`,
      );
      return { proceed: false, state };
    }
  }

  return { proceed: true, state, taskChangedFiles };
}
