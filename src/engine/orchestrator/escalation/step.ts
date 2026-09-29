import { loadState } from '../../../core/state/persistence.js';
import { defaultImplementerWriteMode } from '../../../core/schemas/implementer-config.js';
import { formatValidationError } from '../validation/format-error.js';
import { addUsageAndSave, raisePendingRecovery, transitionAndSave } from '../state-ops.js';
import { buildScopeViolationRecoveryIssue } from '../recovery/builders/task.js';
import { nowIso } from '../../../utils/format-time.js';
import { refreshAndPersistCode } from '../task/refresh-code.js';
import { gateAndPromoteChangedFiles } from '../approval/gate-and-promote.js';
import { withPerCallAbort } from '../cancellable-call.js';
import { publishError } from '../events.js';
import { createRetryRuntime, stateForRetryProfile } from './retry-runtime.js';
import { persistRetryApprovalEvidence, persistRetryRejectionEvidence } from './retry-evidence.js';
import { handleApprovalTimeUserEditConflict } from './approval-conflict.js';
import { validateAndCommit } from './validate-and-commit.js';
import { boundedHandBack, failedRetry } from './types.js';
import type { RetryStepOpts, RetryStepOutcome } from './types.js';
import { recordedApiCreatedPaths } from '../evidence/task.js';
import {
  persistApiApplyEvidence,
  raiseApiApplyRecovery,
  invalidateTargetWriteEvidence,
} from '../evidence/persistence.js';
import { isAbortError } from '../../../utils/abort.js';
import { isResumableWorkspaceStop, workspaceOwner } from '../isolation/retention.js';
import { commitWorkflowState } from '../state-ops.js';
import { error } from '../../../utils/error.js';
import { toErrorMessage } from '../../../utils/format-errors.js';

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
          ...(ctx.undeclaredWrites !== undefined && { undeclaredWrites: ctx.undeclaredWrites }),
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
    const deniedFiles = gateResult.decision.changedFiles;
    const reason = gateResult.decision.reason ?? 'denied';
    const message = `Retry changed files blocked by approval gate: ${reason} (${deniedFiles.join(', ')})`;
    publishError({ bus: ctx.bus, phase: gateResult.state.phase, message });
    persistRetryRejectionEvidence(ctx, gateResult.state, task, gateResult.decision);
    const deniedState =
      gateResult.decision.actionClass === 'write_out_of_scope'
        ? raisePendingRecovery(
            ctx,
            gateResult.state,
            buildScopeViolationRecoveryIssue({
              task,
              phase: gateResult.state.phase,
              undeclaredFiles: deniedFiles,
              attempts,
              maxAttempts: ctx.config.workflow.maxRetries,
              createdAt: nowIso(),
            }),
          )
        : gateResult.state;
    return {
      state: deniedState,
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
  const actualChangedFiles = gateResult.changedFiles;
  const widening = opts.scopeWidening;
  if (widening !== undefined) {
    const widened = actualChangedFiles.filter((file) => widening.paths.includes(file));
    if (widened.length > 0) {
      state = transitionAndSave(ctx, state, {
        type: 'WIDEN_TASK_SCOPE',
        taskId: task.id,
        paths: widened,
        reason: widening.reason,
      });
      task = state.tasks.find((entry) => entry.id === task.id) ?? task;
      ctx.bus.publish({
        type: 'task_scope_widened',
        ts: Date.now(),
        phase: state.phase,
        taskId: task.id,
        paths: widened,
        reason: widening.reason,
      });
    }
  }
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
