import { defaultImplementerWriteMode } from '../../../core/schemas/implementer-config.js';
import { formatValidationError } from '../validation/format-error.js';
import { addUsageAndSave, raisePendingRecovery } from '../state-ops.js';
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
import { failedRetry } from './types.js';
import type { RetryStepOpts, RetryStepOutcome } from './types.js';
import type { AppliedFile, BundleApplyResult } from '../../implementers/file-bundle.js';
import type { PartialPromotionDetail } from '../approval/gate-and-promote.js';
import { readConfinedEntry } from '../approval/file-snapshots/entry.js';
import { recordedApiCreatedPaths } from '../evidence/task.js';
import { persistApiApplyEvidence, raiseApiApplyRecovery } from '../evidence/persistence.js';
import { toErrorMessage } from '../../../utils/format-errors.js';

/** Attribute only gate-confirmed writes whose actual target content matches the response. */
async function targetApplyReceipt(input: {
  projectDir: string;
  result: BundleApplyResult;
  acceptedPaths: readonly string[];
  promotion?: PartialPromotionDetail | undefined;
}): Promise<BundleApplyResult> {
  const { result, promotion } = input;
  if (result.status !== 'applied') return result;
  const accepted = new Set(input.acceptedPaths);
  const applied: AppliedFile[] = [];
  for (const file of result.applied) {
    if (!accepted.has(file.path)) continue;
    if (promotion !== undefined) {
      if (
        promotion.appliedFiles.some(
          (entry) => entry.path === file.path && entry.sha256 === file.afterSha256,
        )
      ) {
        applied.push(file);
      }
      continue;
    }
    try {
      const target = await readConfinedEntry(input.projectDir, file.path);
      if (target.kind === 'file' && target.sha256 === file.afterSha256) applied.push(file);
    } catch {
      // An unreadable target cannot be attributed from its former workspace content.
    }
  }
  const appliedPaths = new Set(applied.map((file) => file.path));
  const missing = result.applied.find((file) => !appliedPaths.has(file.path));
  if (promotion === undefined && missing === undefined) return { ...result, applied };
  const failedPath = promotion?.failedFile ?? missing?.path ?? result.candidatePaths[0] ?? '';
  const error =
    promotion === undefined
      ? `${failedPath}: target content after promotion could not be attributed to this response`
      : toErrorMessage(promotion.error);
  const untouched = [
    ...new Set([
      ...result.untouched,
      ...result.candidatePaths.filter(
        (path) => !appliedPaths.has(path) && !result.noops.includes(path),
      ),
    ]),
  ].sort();
  const common = {
    callId: result.callId,
    candidatePaths: result.candidatePaths,
    code: 'write-uncertain' as const,
    error,
    failedPath,
    noops: result.noops,
    untouched,
  };
  return applied.length === 0
    ? { ...common, status: 'failed', applied: [] }
    : { ...common, status: 'partial', applied };
}

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

  const workspace = await ctx.isolation.acquire({
    role: isolationRole ?? 'implementer',
    config: retryRuntime.config,
    writesFiles:
      retryRuntime.implementer.capabilities?.writesFiles ??
      defaultImplementerWriteMode(retryRuntime.config.implementer.kind),
  });
  let retryResult: Awaited<ReturnType<typeof invokeRetry>>;
  try {
    retryResult = await withPerCallAbort({
      sinks: ctx.sinks,
      signal: ctx.signal,
      run: (signal) =>
        invokeRetry({
          task,
          lastError,
          attempts,
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
    workspace.cleanup();
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

  if (!retryResult.success) {
    workspace.cleanup();
    return {
      state,
      task,
      lastError: retryResult.error ?? retryFailureFallback,
      attempts,
      ...(retryResult.outcome !== undefined && {
        lastFailure: {
          outcome: retryResult.outcome,
          runner: retryResult.runner ?? retryRuntime.config.implementer,
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
    workspace,
    usesIsolation: true,
    taskStartSnapshot: ctx.taskStartSnapshot,
    dependsOnFiles: ctx.dependsOnFiles,
    signal: ctx.signal,
    cleanup: workspace.cleanup,
    handleConflict: (s, files) =>
      handleApprovalTimeUserEditConflict({ ctx, state: s, task, files }),
    onApproved: (decision) => persistRetryApprovalEvidence(ctx, state, task, decision),
  });

  if (gateResult.outcome === 'error') {
    if (applyResult !== undefined && gateResult.promotion !== undefined) {
      const targetResult = await targetApplyReceipt({
        projectDir: ctx.projectDir,
        result: applyResult,
        acceptedPaths: gateResult.promotion.appliedFiles.map((file) => file.path),
        promotion: gateResult.promotion,
      });
      persistApiApplyEvidence({ wctx: ctx, state: gateResult.state, task, result: targetResult });
    }
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
      attempts,
      result: failedRetry(attempts),
    };
  }
  if (gateResult.outcome === 'gate-denied') {
    const deniedFiles = gateResult.decision.changedFiles;
    const reason = gateResult.decision.reason ?? 'denied';
    publishError({
      bus: ctx.bus,
      phase: gateResult.state.phase,
      message: `Retry changed files blocked by approval gate: ${reason} (${deniedFiles.join(', ')})`,
    });
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
  if (applyResult !== undefined) {
    const targetResult = await targetApplyReceipt({
      projectDir: ctx.projectDir,
      result: applyResult,
      acceptedPaths: actualChangedFiles,
    });
    persistApiApplyEvidence({ wctx: ctx, state, task, result: targetResult });
    if (targetResult.status === 'partial' || targetResult.status === 'failed') {
      state = raiseApiApplyRecovery({ wctx: ctx, state, task, result: targetResult });
      return {
        state,
        task,
        lastError: targetResult.error,
        attempts,
        result: failedRetry(attempts),
      };
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
