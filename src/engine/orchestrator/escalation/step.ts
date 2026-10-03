import { loadState } from '../../../core/state/persistence.js';
import { defaultImplementerWriteMode } from '../../../core/schemas/implementer-config.js';
import type { ChangedFilesSnapshot } from '../../../core/schemas/workflow.js';
import type { ImplementerReport } from '../../../core/schemas/consult.js';
import { formatValidationError } from '../validation/format-error.js';
import { addUsageAndSave } from '../state-ops.js';
import { refreshAndPersistCode } from '../task/refresh-code.js';
import { gateAndPromoteChangedFiles } from '../approval/gate-and-promote.js';
import { getChangedFilesSnapshot } from '../approval/file-snapshots/capture.js';
import { withPerCallAbort } from '../cancellable-call.js';
import { publishError, publishWarningFromError } from '../events.js';
import { createRetryRuntime, stateForRetryProfile } from './retry-runtime.js';
import { persistRetryApprovalEvidence, recordRetryDenial } from './retry-evidence.js';
import { handleApprovalTimeUserEditConflict } from './approval-conflict.js';
import { validateAndCommit } from './validate-and-commit.js';
import { boundedHandBack, failedRetry } from './types.js';
import type { RetryInvokeResult, RetryStepOpts, RetryStepOutcome } from './types.js';
import { recordedApiCreatedPaths } from '../evidence/task.js';
import {
  persistApiApplyEvidence,
  raiseApiApplyRecovery,
  invalidateTargetWriteEvidence,
} from '../evidence/persistence.js';
import { isAbortError } from '../../../utils/abort.js';
import { isRecord } from '../../../utils/type-guards.js';
import { isResumableWorkspaceStop, workspaceOwner } from '../isolation/retention.js';
import { commitWorkflowState } from '../state-ops.js';
import { error } from '../../../utils/error.js';
import { toErrorMessage } from '../../../utils/format-errors.js';

/** The direct writer's blocked report: the attempt stopped asking for a decision. */
export type BlockedReport = Extract<ImplementerReport, { status: 'blocked' }>;

/** A retry outcome, with the blocked report an attempt handed back when it stopped to ask. */
export type RetryStepResult = RetryStepOutcome & {
  blocked?: BlockedReport | undefined;
};

/**
 * The blocked report behind a result, read from the pipeline's own verdict. A
 * result that does not carry one — every successful attempt, every failure with
 * a machine outcome — changes nothing.
 */
function blockedReportOf(result: RetryInvokeResult): BlockedReport | undefined {
  if (!('blocked' in result)) return undefined;
  const blocked: unknown = result.blocked;
  if (!isRecord(blocked)) return undefined;
  const question = blocked.question;
  if (typeof question !== 'string') return undefined;
  const filesNeeded = Array.isArray(blocked.filesNeeded)
    ? blocked.filesNeeded.filter((file): file is string => typeof file === 'string')
    : [];
  return { status: 'blocked', question, filesNeeded };
}

export async function runRetryStep(opts: RetryStepOpts): Promise<RetryStepResult> {
  let attemptSnapshot: ChangedFilesSnapshot | undefined;
  try {
    attemptSnapshot = await getChangedFilesSnapshot(opts.ctx.projectDir);
  } catch (err) {
    publishWarningFromError(
      { bus: opts.ctx.bus, phase: opts.state.phase },
      'retry attempt snapshot failed',
      err,
    );
  }
  const outcome = await runRetryStepAttempt(opts);
  return attemptSnapshot === undefined ? outcome : { ...outcome, attemptSnapshot };
}

async function runRetryStepAttempt(opts: RetryStepOpts): Promise<RetryStepResult> {
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
    isolationRole,
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
  }

  const invocationAttempt = Math.max(state.attempt, attempts);
  if (state.attempt !== invocationAttempt) {
    const saved = commitWorkflowState({
      ref: ctx,
      expected: loadState(ctx) === null ? null : state,
      next: { ...state, attempt: invocationAttempt },
    });
    if (saved.kind !== 'committed')
      throw error(
        'retry-state-persistence',
        'Could not persist the retry attempt before execution.',
      );
    state = saved.state;
  }
  const workspace = await ctx.isolation.acquire({
    role: isolationRole ?? 'implementer',
    owner: workspaceOwner({ task, attempt: state.attempt, config: retryRuntime.config }),
    config: retryRuntime.config,
    writesFiles:
      retryRuntime.implementer.capabilities?.writesFiles ??
      defaultImplementerWriteMode(retryRuntime.config.implementer.kind),
  });
  let retryResult: Awaited<ReturnType<typeof invokeRetry>>;
  try {
    if (workspace.projectDir === ctx.projectDir) {
      invalidateTargetWriteEvidence({ ref: ctx, task });
    }
    retryResult = await withPerCallAbort({
      sinks: ctx.sinks,
      signal: ctx.signal,
      run: (signal) =>
        invokeRetry({
          task,
          lastError,
          attempts: state.attempt,
          projectDir: workspace.projectDir,
          config: retryRuntime.config,
          implementer: retryRuntime.implementer,
          ...(retryRuntime.implementerProfile !== undefined && {
            implementerProfile: retryRuntime.implementerProfile,
          }),
          signal,
          sandboxEnv: workspace.sandboxEnv,
          fileIgnoreProjectDir: ctx.projectDir,
          changeDetection: workspace.changeDetection,
          createdByThisTask: recordedApiCreatedPaths(ctx, task),
          seat: { ref: ctx, state, usageCategory },
        }),
    });
  } catch (err) {
    if (isAbortError(err) && isResumableWorkspaceStop(ctx.signal)) await workspace.retain?.();
    else workspace.cleanup();
    throw err;
  }
  state = addUsageAndSave(ctx, state, usageCategory, retryResult.usage);

  const applyResult = retryResult.applyResult;
  const workspacePath = workspace.projectDir === ctx.projectDir ? undefined : workspace.projectDir;
  if (applyResult !== undefined) {
    persistApiApplyEvidence({ wctx: ctx, state, task, result: applyResult, workspacePath });
  }
  if (
    applyResult?.status === 'partial' ||
    (applyResult?.status === 'failed' && applyResult.code === 'write-uncertain')
  ) {
    state = raiseApiApplyRecovery({ wctx: ctx, state, task, result: applyResult, workspacePath });
    return { state, task, lastError: applyResult.error, attempts, result: failedRetry(attempts) };
  }

  if (ctx.signal?.aborted && applyResult === undefined) {
    if (
      isResumableWorkspaceStop(ctx.signal) &&
      (retryResult.success || retryResult.outcome === 'user-abort')
    )
      await workspace.retain?.();
    else workspace.cleanup();
    return { state, task, lastError, attempts: state.attempt, result: failedRetry(state.attempt) };
  }

  if (!retryResult.success) {
    workspace.cleanup();
    const handBack = boundedHandBack(retryResult.output);
    const blocked = blockedReportOf(retryResult);
    return {
      state,
      task,
      // An attempt that changed nothing failed on the error it was given, not on its own words.
      lastError:
        retryResult.outcome === 'no-staged-change'
          ? lastError
          : (retryResult.error ?? retryFailureFallback),
      attempts,
      ...(retryResult.outcome !== undefined && {
        lastFailure: {
          outcome: retryResult.outcome,
          runner: retryResult.runner ?? retryRuntime.config.implementer,
          ...(handBack !== undefined && { handBack }),
        },
      }),
      ...(blocked !== undefined && { blocked }),
    };
  }
  if (ctx.signal?.aborted) {
    workspace.cleanup();
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
    workspace: workspacePath === undefined ? undefined : workspace,
    taskStartSnapshot: ctx.taskStartSnapshot,
    dependsOnFiles: ctx.dependsOnFiles,
    signal: ctx.signal,
    cleanup: workspace.cleanup,
    handleConflict: (s, files) =>
      handleApprovalTimeUserEditConflict({
        ctx,
        state: s,
        task,
        files,
        workspacePath: workspace.projectDir,
      }),
    onApproved: (decision) => persistRetryApprovalEvidence(ctx, state, task, decision),
  });

  if (gateResult.outcome === 'error') {
    if (gateResult.state.pendingRecovery !== undefined) {
      return {
        state: gateResult.state,
        task,
        lastError: toErrorMessage(gateResult.error),
        attempts,
        result: failedRetry(attempts),
      };
    }
    throw gateResult.error;
  }
  if (gateResult.outcome === 'aborted') {
    return {
      state,
      task,
      lastError,
      attempts: state.attempt,
      result: failedRetry(state.attempt),
    };
  }
  if (gateResult.outcome === 'gate-denied') {
    const message = recordRetryDenial({
      ctx,
      state: gateResult.state,
      task,
      denial: gateResult.denial,
      subject: 'Retry',
      blocked: true,
    });
    return {
      state: gateResult.state,
      task,
      lastError: message,
      attempts,
      result: failedRetry(attempts, { lastError: message }),
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
  if (gateResult.denial !== undefined) {
    recordRetryDenial({
      ctx,
      state,
      task,
      denial: gateResult.denial,
      subject: 'Retry',
      blocked: false,
    });
  }
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
        acceptance: commitResult.acceptance,
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
    commitResult.acceptance,
  );
  onValidationAfterRetryFail?.(validationError);
  return { state: commitResult.state, task, lastError: validationError, attempts };
}
