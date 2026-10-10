import { loadState } from '../../../core/state/persistence.js';
import { ImplementerReportSchema, type ImplementerReport } from '../../../core/schemas/consult.js';
import { addUsageAndSave, rebaseOnPersistedWorkflowState } from '../state-ops.js';
import { refreshAndPersistCode } from '../task/refresh-code.js';
import { gateAttemptChanges } from '../task/attempt-gate.js';
import { captureTaskReviewChanges } from '../evidence/review-capture.js';
import { getChangedFilesSinceSnapshot } from '../approval/file-snapshots/capture.js';
import { withPerCallAbort } from '../cancellable-call.js';
import { createRetryRuntime, type RetryRuntime, stateForRetryProfile } from './retry-runtime.js';
import { persistRetryApprovalEvidence, recordRetryDenial } from './retry-evidence.js';
import { validateAndCommit } from './validate-and-commit.js';
import { boundedHandBack, failedRetry } from './types.js';
import type { RetryInvokeResult, RetryStepOpts, RetryStepOutcome } from './types.js';
import { recordedApiCreatedPaths } from '../evidence/task.js';
import { raiseApiApplyRecovery } from '../evidence/persistence.js';
import { isAbortError } from '../../../utils/abort.js';
import { isRecord } from '../../../utils/type-guards.js';
import { isResumableWorkspaceStop } from '../isolation/retention.js';
import type { AttemptWorkspace } from '../isolation/types.js';
import { commitWorkflowState } from '../state-ops.js';
import { error } from '../../../utils/error.js';
import { confirmAttemptDecisions } from '../consult/decision-confirm.js';

/** The direct writer's blocked report: the attempt stopped asking for a decision. */
export type BlockedReport = Extract<ImplementerReport, { status: 'blocked' }>;

/** The direct writer's reported deviation: a done report proposing ledger decisions. */
type DeviationReport = Extract<ImplementerReport, { status: 'done' }>;

/**
 * A retry outcome, with the blocked report an attempt handed back when it
 * stopped to ask, or the user's answer to a change of what it reported.
 */
export type RetryStepResult = RetryStepOutcome & {
  blocked?: BlockedReport | undefined;
  answer?: string | undefined;
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

/**
 * The deviation behind a result, read from the pipeline's own report. A result
 * that carries none — every non-direct writer, every done report that proposes
 * no decision — changes nothing.
 */
function deviationReportOf(result: RetryInvokeResult): DeviationReport | undefined {
  if (!('report' in result)) return undefined;
  const parsed = ImplementerReportSchema.safeParse(result.report);
  if (!parsed.success || parsed.data.status !== 'done' || parsed.data.decisions.length === 0) {
    return undefined;
  }
  return parsed.data;
}

export async function runRetryStep(opts: RetryStepOpts): Promise<RetryStepResult> {
  const { ctx, attempts, profileOverride, isolationRole } = opts;
  let { state, task } = opts;
  ({ task, state } = await refreshAndPersistCode(task, ctx, state, ctx.workspaceDir));

  const retryRuntime = await createRetryRuntime(ctx, profileOverride);
  state = rebaseOnPersistedWorkflowState(ctx, state);
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
    config: retryRuntime.config,
  });
  const outcome = await runRetryStepAttempt({ ...opts, state, task }, retryRuntime, workspace);
  return { ...outcome, attemptSnapshot: workspace.snapshot };
}

async function runRetryStepAttempt(
  opts: RetryStepOpts,
  retryRuntime: RetryRuntime,
  workspace: AttemptWorkspace,
): Promise<RetryStepResult> {
  const {
    ctx,
    state: initialState,
    task,
    lastError,
    attempts,
    method,
    transitionType,
    commitSuffix,
    usageCategory,
    retryFailureFallback,
    resultTool,
    resultModel,
    invokeRetry,
    onValidationAfterRetryFail,
  } = opts;
  let state = initialState;
  const retryCtx = {
    ...ctx,
    config: retryRuntime.config,
    implementer: retryRuntime.implementer,
    ...(retryRuntime.implementerProfile !== undefined && {
      implementerProfile: retryRuntime.implementerProfile,
    }),
  };
  let retryResult: Awaited<ReturnType<typeof invokeRetry>>;
  try {
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
          createdByThisTask: recordedApiCreatedPaths(ctx, task, workspace.projectDir),
          seat: { ref: ctx, state, usageCategory },
        }),
    });
  } catch (err) {
    if (isAbortError(err) && isResumableWorkspaceStop(ctx.signal)) await workspace.retain?.();
    else workspace.cleanup();
    throw err;
  }
  state = rebaseOnPersistedWorkflowState(ctx, state);
  state = addUsageAndSave(ctx, state, usageCategory, retryResult.usage);

  const applyResult = retryResult.applyResult;
  if (
    applyResult?.status === 'partial' ||
    (applyResult?.status === 'failed' && applyResult.code === 'write-uncertain')
  ) {
    state = await raiseApiApplyRecovery({ wctx: ctx, state, task, result: applyResult, workspace });
    return { state, task, lastError: applyResult.error, attempts, result: failedRetry(attempts) };
  }

  if (ctx.signal?.aborted && (applyResult === undefined || applyResult.status === 'applied')) {
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
      lastError: retryResult.error ?? retryFailureFallback,
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
  const gate = await gateAttemptChanges({
    wctx: ctx,
    task,
    phase: state.phase,
    workspace,
    preApprovedFiles: [],
    dependsOnFiles: ctx.dependsOnFiles,
    onApproved: (decision) => persistRetryApprovalEvidence(ctx, state, task, decision),
  });
  if (gate.outcome === 'aborted' || gate.outcome === 'cancelled') {
    return {
      state,
      task,
      lastError,
      attempts: state.attempt,
      result: failedRetry(state.attempt),
    };
  }
  if (gate.outcome === 'denied') {
    const message = recordRetryDenial({
      ctx,
      state,
      task,
      denial: gate.denial,
      subject: 'Retry',
      blocked: true,
    });
    return {
      state,
      task,
      lastError: message,
      attempts,
      result: failedRetry(attempts, { lastError: message }),
    };
  }
  if (gate.denial !== undefined) {
    recordRetryDenial({
      ctx,
      state,
      task,
      denial: gate.denial,
      subject: 'Retry',
      blocked: false,
    });
  }
  const actualChangedFiles = gate.approvedFiles;
  const confirmed = await confirmAttemptDecisions({
    wctx: retryCtx,
    task,
    state,
    report: deviationReportOf(retryResult),
    snapshot: workspace.snapshot,
    changedFiles: actualChangedFiles,
    taskStartTime: ctx.taskStartTime,
  });
  state = confirmed.state;
  if (confirmed.kind === 'answer') {
    return { state, task, lastError: confirmed.answer, attempts, answer: confirmed.answer };
  }
  if (confirmed.kind === 'retry') return { state, task, lastError: confirmed.error, attempts };
  const commitResult = await validateAndCommit({
    ctx: retryCtx,
    task,
    state,
    method,
    transitionType,
    retryCount: attempts,
    commitSuffix,
    preApprovedChangedFiles: await getChangedFilesSinceSnapshot(
      ctx.workspaceDir,
      ctx.taskStartSnapshot,
    ),
  });
  if ('answer' in commitResult) {
    return {
      state: commitResult.state,
      task,
      lastError: commitResult.answer,
      attempts,
      answer: commitResult.answer,
    };
  }
  if ('blockedReason' in commitResult) {
    return {
      state: commitResult.state,
      task,
      lastError: commitResult.blockedReason,
      attempts,
      result:
        commitResult.blockedReason === 'skipped'
          ? { completed: false, method: 'skipped', attempts }
          : failedRetry(attempts),
    };
  }
  if (commitResult.completed) {
    await captureTaskReviewChanges({
      ref: { projectDir: ctx.projectDir, sessionId: ctx.sessionId },
      workspaceDir: ctx.workspaceDir,
      task,
      taskStartSnapshot: ctx.taskStartSnapshot,
    });
    return {
      state: commitResult.state,
      task,
      lastError,
      attempts,
      result: {
        completed: true,
        method,
        attempts,
        durationMs: commitResult.durationMs,
        ...(actualChangedFiles.length > 0 && { changedFiles: actualChangedFiles }),
        ...(resultTool !== undefined && { tool: resultTool }),
        ...(resultModel !== undefined && { model: resultModel }),
      },
    };
  }

  onValidationAfterRetryFail?.(commitResult.error);
  return {
    state: commitResult.state,
    task,
    lastError: commitResult.error,
    diagnosis: commitResult.diagnosis,
    attempts,
  };
}
