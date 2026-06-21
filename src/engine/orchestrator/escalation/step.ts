import { saveState } from '../../../core/state/persistence.js';
import { formatValidationError } from '../validation.js';
import { refreshAndPersistCode, addUsageAndSave } from '../state-ops.js';
import { createStagedProject } from '../approval/staged-project.js';
import { gateAndPromoteChangedFiles } from '../approval/gate-and-promote.js';
import { publishError } from '../events.js';
import { createRetryRuntime, stateForRetryProfile } from './retry-runtime.js';
import { persistRetryApprovalEvidence, persistRetryRejectionEvidence } from './retry-evidence.js';
import { handleApprovalTimeUserEditConflict } from './approval-conflict.js';
import { validateAndCommit } from './validate-and-commit.js';
import { failedRetry } from './types.js';
import type { RetryStepOpts, RetryStepOutcome } from './types.js';

export async function runRetryStep(opts: RetryStepOpts): Promise<RetryStepOutcome> {
  const {
    ctx,
    state: initialState,
    lastError,
    attempts,
    method,
    transitionType,
    commitSuffix,
    usageCategory,
    retryFailureFallback,
    profileOverride,
    resultTool,
    resultModel,
    invokeRetry,
    onValidationAfterRetryFail,
  } = opts;
  let state = initialState;
  let task = opts.task;
  ({ task, state } = await refreshAndPersistCode(task, ctx, state));

  const retryRuntime = await createRetryRuntime(ctx, profileOverride);
  const retryCtx = {
    ...ctx,
    config: retryRuntime.config,
    implementer: retryRuntime.implementer,
    ...(retryRuntime.implementerProfile !== undefined && {
      implementerProfile: retryRuntime.implementerProfile,
    }),
  };
  if (retryRuntime.profile !== undefined) {
    state = stateForRetryProfile(state, retryRuntime.profile);
    saveState(ctx, state);
  }

  const staged = await createStagedProject(ctx.projectDir, retryRuntime.config);
  let retryResult: Awaited<ReturnType<typeof invokeRetry>>;
  try {
    retryResult = await invokeRetry({
      task,
      lastError,
      attempts,
      projectDir: staged.projectDir,
      config: retryRuntime.config,
      implementer: retryRuntime.implementer,
      ...(retryRuntime.implementerProfile !== undefined && {
        implementerProfile: retryRuntime.implementerProfile,
      }),
      signal: ctx.signal,
      sandboxEnv: staged.sandboxEnv,
      fileIgnoreProjectDir: ctx.projectDir,
    });
  } catch (err) {
    staged.cleanup();
    throw err;
  }
  state = addUsageAndSave(ctx, state, usageCategory, retryResult.usage);

  if (!retryResult.success) {
    staged.cleanup();
    return { state, task, lastError: retryResult.error ?? retryFailureFallback, attempts };
  }
  if (ctx.signal?.aborted) {
    staged.cleanup();
    return {
      state,
      task,
      lastError,
      attempts,
      result: failedRetry(attempts),
    };
  }

  const gateResult = await gateAndPromoteChangedFiles({
    task,
    state,
    projectDir: ctx.projectDir,
    sessionId: ctx.sessionId,
    bus: ctx.bus,
    callbacks: ctx.callbacks,
    config: ctx.config,
    getApprovalEnabled: ctx.getApprovalEnabled,
    staged,
    usesStaging: true,
    taskStartSnapshot: ctx.taskStartSnapshot,
    dependsOnFiles: ctx.dependsOnFiles,
    promoteFromStagingOnly: true,
    signal: ctx.signal,
    cleanup: staged.cleanup,
    handleConflict: (s, files) =>
      handleApprovalTimeUserEditConflict({ ctx, state: s, task, files }),
    onApproved: (decision) => persistRetryApprovalEvidence(ctx, state, task, decision),
  });

  if (gateResult.outcome === 'error') throw gateResult.error;
  if (gateResult.outcome === 'aborted') {
    return {
      state,
      task,
      lastError,
      attempts,
      result: failedRetry(attempts),
    };
  }
  if (gateResult.outcome === 'gate-denied') {
    const files = gateResult.decision.changedFiles.join(', ');
    const reason = gateResult.decision.reason ?? 'denied';
    publishError({
      bus: ctx.bus,
      phase: gateResult.state.phase,
      message: `Retry changed files blocked by approval gate: ${reason} (${files})`,
    });
    persistRetryRejectionEvidence(ctx, gateResult.state, task, gateResult.decision);
    return {
      state: gateResult.state,
      task,
      lastError: reason,
      attempts,
      result: failedRetry(attempts),
    };
  }
  if (gateResult.outcome === 'promote-conflict') {
    const reason = `Approved retry promotion blocked because files changed during approval: ${gateResult.conflictedFiles.join(', ')}`;
    publishError({ bus: ctx.bus, phase: gateResult.state.phase, message: reason });
    return {
      state: gateResult.state,
      task,
      lastError: reason,
      attempts,
      result: failedRetry(attempts),
    };
  }
  state = gateResult.state;
  const actualChangedFiles = gateResult.changedFiles;

  const commitResult = await validateAndCommit({
    ctx: retryCtx,
    task,
    state,
    method,
    transitionType,
    retryCount: attempts,
    commitSuffix,
    preApprovedChangedFiles: actualChangedFiles,
  });
  if ('blockedReason' in commitResult) {
    return {
      state: commitResult.state,
      task,
      lastError: commitResult.blockedReason,
      attempts,
      result: failedRetry(attempts),
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
        ...(commitResult.validationResults.length > 0 && {
          validationResults: commitResult.validationResults,
        }),
        ...(actualChangedFiles.length > 0 && { changedFiles: actualChangedFiles }),
        ...(resultTool !== undefined && { tool: resultTool }),
        ...(resultModel !== undefined && { model: resultModel }),
      },
    };
  }

  const validationError = formatValidationError(
    commitResult.validationResults,
    ctx.validator.getBaselineFailingStages?.(),
  );
  onValidationAfterRetryFail?.(validationError);
  return { state: commitResult.state, task, lastError: validationError, attempts };
}
