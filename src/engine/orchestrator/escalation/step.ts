import { saveState } from '../../../core/state/persistence.js';
import { formatValidationError } from '../validation.js';
import { refreshAndPersistCode, addUsageAndSave } from '../state-ops.js';
import { captureCurrentFileContents, getChangedFilesSinceSnapshot, restoreDirtyFilesFromSnapshot } from '../approval/file-snapshots.js';
import { createStagedProject, promoteStagedChanges } from '../approval/staged-project.js';
import { gateChangedFiles } from '../approval/gate-files.js';
import { publishError } from '../events.js';
import { createRetryRuntime, stateForRetryProfile } from './retry-runtime.js';
import { persistRetryApprovalEvidence, persistRetryRejectionEvidence } from './retry-evidence.js';
import { handleApprovalTimeUserEditConflict } from './approval-conflict.js';
import { validateAndCommit } from './validate-and-commit.js';
import type { RetryStepOpts, RetryStepOutcome } from './types.js';

export async function runRetryStep(opts: RetryStepOpts): Promise<RetryStepOutcome> {
  const { ctx, state: initialState, lastError, attempts, method, transitionType, commitSuffix, usageCategory, retryFailureFallback, profileOverride, invokeRetry, onValidationAfterRetryFail } = opts;
  let state = initialState;
  let task = opts.task;
  ({ task, state } = await refreshAndPersistCode(task, ctx.projectDir, ctx.sessionId, state));

  const retryRuntime = await createRetryRuntime(ctx, profileOverride);
  const retryCtx = { ...ctx, config: retryRuntime.config, implementer: retryRuntime.implementer, ...(retryRuntime.implementerProfile !== undefined && { implementerProfile: retryRuntime.implementerProfile }) };
  if (retryRuntime.profile !== undefined) {
    state = stateForRetryProfile(state, retryRuntime.profile);
    saveState(ctx.projectDir, ctx.sessionId, state);
  }

  const staged = await createStagedProject(ctx.projectDir);
  let retryResult: Awaited<ReturnType<typeof invokeRetry>>;
  try {
    retryResult = await invokeRetry({
      task,
      lastError,
      attempts,
      projectDir: staged.projectDir,
      config: retryRuntime.config,
      implementer: retryRuntime.implementer,
      ...(retryRuntime.implementerProfile !== undefined && { implementerProfile: retryRuntime.implementerProfile }),
      signal: ctx.signal,
    });
  } catch (err) {
    staged.cleanup();
    throw err;
  }
  state = addUsageAndSave(ctx.projectDir, ctx.sessionId, state, usageCategory, retryResult.usage, ctx.bus);

  if (!retryResult.success) {
    staged.cleanup();
    return { state, task, lastError: retryResult.error ?? retryFailureFallback, attempts };
  }
  if (ctx.signal?.aborted) {
    staged.cleanup();
    return { state, task, lastError, attempts, result: { completed: false, method: 'failed', attempts } };
  }

  const stagedChangedFiles = await getChangedFilesSinceSnapshot(staged.projectDir, ctx.taskStartSnapshot);
  const actualChangedFiles = stagedChangedFiles.length > 0
    ? stagedChangedFiles
    : await getChangedFilesSinceSnapshot(ctx.projectDir, ctx.taskStartSnapshot);
  const preApprovalChangedFileContents = await captureCurrentFileContents(ctx.projectDir, actualChangedFiles);
  const changedFilesGate = await gateChangedFiles({
    changedFiles: actualChangedFiles,
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
  if (ctx.signal?.aborted) {
    staged.cleanup();
    return { state, task, lastError, attempts, result: { completed: false, method: 'failed', attempts } };
  }
  if (!changedFilesGate.allow) {
    const files = changedFilesGate.changedFiles.join(', ');
    const reason = changedFilesGate.reason ?? 'denied';
    let nextState = state;
    if (stagedChangedFiles.length === 0 && actualChangedFiles.length > 0) {
      const restoreResult = await restoreDirtyFilesFromSnapshot(
        ctx.projectDir,
        ctx.taskStartSnapshot,
        actualChangedFiles,
        preApprovalChangedFileContents,
      );
      if (restoreResult.conflictedFiles.length > 0) {
        nextState = await handleApprovalTimeUserEditConflict({
          ctx,
          state,
          task,
          files: restoreResult.conflictedFiles,
        });
      }
    }
    publishError({ bus: ctx.bus, phase: nextState.phase }, `Retry changed files blocked by approval gate: ${reason} (${files})`);
    persistRetryRejectionEvidence(ctx, nextState, task, changedFilesGate);
    staged.cleanup();
    return {
      state: nextState,
      task,
      lastError: reason,
      attempts,
      result: { completed: false, method: 'failed', attempts },
    };
  }
  persistRetryApprovalEvidence(ctx, state, task, changedFilesGate);

  if (stagedChangedFiles.length > 0) {
    const promoted = await promoteStagedChanges(ctx.projectDir, staged.projectDir, stagedChangedFiles, preApprovalChangedFileContents);
    if (promoted.conflictedFiles.length > 0) {
      state = await handleApprovalTimeUserEditConflict({
        ctx,
        state,
        task,
        files: promoted.conflictedFiles,
      });
      const reason = `Approved retry promotion blocked because files changed during approval: ${promoted.conflictedFiles.join(', ')}`;
      publishError({ bus: ctx.bus, phase: state.phase }, reason);
      staged.cleanup();
      return {
        state,
        task,
        lastError: reason,
        attempts,
        result: { completed: false, method: 'failed', attempts },
      };
    }
  }
  staged.cleanup();

  const commitResult = await validateAndCommit(retryCtx, task, state, method, transitionType, attempts, commitSuffix, actualChangedFiles);
  if ('blockedReason' in commitResult) {
    return {
      state: commitResult.state,
      task,
      lastError: commitResult.blockedReason,
      attempts,
      result: { completed: false, method: 'failed', attempts },
    };
  }
  if (commitResult.completed) {
    return {
      state: commitResult.state,
      task,
      lastError,
      attempts,
      result: {
        completed: true,
        method,
        attempts,
        ...(commitResult.validationResults.length > 0 && { validationResults: commitResult.validationResults }),
        ...(actualChangedFiles.length > 0 && { changedFiles: actualChangedFiles }),
      },
    };
  }

  const validationError = formatValidationError(commitResult.validationResults);
  onValidationAfterRetryFail?.(validationError);
  return { state: commitResult.state, task, lastError: validationError, attempts };
}
