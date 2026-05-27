import type { Task } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { TaskCompletionMethod } from '../../../core/schemas/enums.js';
import { toErrorMessage } from '../../../utils/format-errors.js';
import { publishError } from '../events.js';
import { validateCommitAndAdvance } from '../task/commit.js';
import {
  captureCurrentFileContents,
  getChangedFilesSinceSnapshot,
  restoreDirtyFilesFromSnapshot,
} from '../approval/file-snapshots.js';
import { gateChangedFiles } from '../approval/gate-files.js';
import { handleApprovalTimeUserEditConflict } from './approval-conflict.js';
import { persistRetryApprovalEvidence, persistRetryRejectionEvidence } from './retry-evidence.js';
import type { EscalationContext } from './types.js';

export async function validateAndCommit(
  ctx: EscalationContext,
  task: Task,
  state: WorkflowState,
  method: TaskCompletionMethod,
  transitionType: 'VALIDATION_PASS' | 'HINT_SUCCESS' | 'FULL_SUCCESS',
  retryCount: number,
  commitSuffix?: string,
  preApprovedChangedFiles?: string[],
) {
  let changedFiles: string[];
  try {
    changedFiles = preApprovedChangedFiles ?? await getChangedFilesSinceSnapshot(ctx.projectDir, ctx.taskStartSnapshot);
  } catch (err) {
    const reason = toErrorMessage(err);
    publishError({ bus: ctx.bus, phase: state.phase }, `Retry changed files blocked by approval gate: ${reason}`);
    return {
      state,
      completed: false,
      validationResults: [],
      blockedReason: reason,
    };
  }
  if (preApprovedChangedFiles === undefined) {
    const preApprovalChangedFileContents = await captureCurrentFileContents(ctx.projectDir, changedFiles);
    const changedFilesGate = await gateChangedFiles({
      changedFiles,
      task,
      dependsOnFiles: ctx.dependsOnFiles,
      projectDir: ctx.projectDir,
      sessionId: ctx.sessionId,
      phase: state.phase,
      taskId: task.id,
      bus: ctx.bus,
      callbacks: ctx.callbacks,
      config: ctx.config,
    });
    if (!changedFilesGate.allow) {
      const files = changedFilesGate.changedFiles.join(', ');
      const reason = changedFilesGate.reason ?? 'denied';
      let nextState = state;
      try {
        const restoreResult = await restoreDirtyFilesFromSnapshot(
          ctx.projectDir,
          ctx.taskStartSnapshot,
          changedFilesGate.changedFiles,
          preApprovalChangedFileContents,
        );
        if (restoreResult.conflictedFiles.length > 0) {
          nextState = await handleApprovalTimeUserEditConflict({
            ctx,
            state,
            task,
            files: restoreResult.conflictedFiles,
          });
          publishError({ bus: ctx.bus, phase: nextState.phase },
            `Denied retry rollback skipped files changed during approval: ${restoreResult.conflictedFiles.join(', ')}`,
          );
        }
      } catch (err) {
        publishError({ bus: ctx.bus, phase: state.phase }, `Failed to discard denied retry changes: ${toErrorMessage(err)}`);
      }
      publishError({ bus: ctx.bus, phase: nextState.phase }, `Retry changed files blocked by approval gate: ${reason} (${files})`);
      persistRetryRejectionEvidence(ctx, nextState, task, changedFilesGate);
      return {
        state: nextState,
        completed: false,
        validationResults: [],
        blockedReason: reason,
      };
    }
    persistRetryApprovalEvidence(ctx, state, task, changedFilesGate);
  }

  const validationResults = await ctx.validator.runValidation(task, ctx.projectDir, ctx.config, ctx.bus, state.phase, task.id, state.discoveredValidation);
  const result = await validateCommitAndAdvance({
    task, projectDir: ctx.projectDir, sessionId: ctx.sessionId,
    config: ctx.config, bus: ctx.bus,
    state, method, transitionType, commitSuffix,
    taskStartTime: ctx.taskStartTime, retryCount,
    implementerProfile: ctx.implementerProfile,
    results: validationResults,
  });
  return { ...result, validationResults };
}
