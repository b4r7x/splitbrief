import { loadState } from '../../../core/state/persistence.js';
import { readImplementerReport, type ImplementerReport } from '../../../core/schemas/consult.js';
import { transitionAndSave } from '../state-ops/transition.js';
import { rebaseOnPersistedWorkflowState } from '../state-ops/head.js';
import { refreshAndPersistCode } from '../task/refresh-code.js';
import { gateAttemptChanges } from '../task/gates/attempt.js';
import { persistRetryApprovalEvidence, recordRetryDenial } from './retry-evidence.js';
import { validateAndCommitRetry } from './validate-and-commit.js';
import { invokeRetryAttempt } from './invoke.js';
import { boundedHandBack, failedRetry } from './types.js';
import type { BlockedReport, RetryInvokeResult, RetryStepOpts, RetryStepResult } from './types.js';
import { raiseApiApplyRecovery } from '../evidence/persistence.js';
import { isRecord } from '../../../utils/type-guards.js';
import { isResumableWorkspaceStop } from '../isolation/thrown-call.js';
import type { AttemptWorkspace } from '../isolation/types.js';
import { commitWorkflowState } from '../state-ops/commit.js';
import { stateOpsError } from '../state-ops/errors.js';

/** The direct writer's done report: what it changed and the decisions it took. */
type DoneReport = Extract<ImplementerReport, { status: 'done' }>;

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
 * The done report behind a result, read from the pipeline's own report. A result
 * that carries none — every non-direct writer, every blocked report — changes nothing.
 */
function doneReportOf(result: RetryInvokeResult): DoneReport | undefined {
  if (!('report' in result)) return undefined;
  const report = readImplementerReport(result.report)?.report;
  return report?.status === 'done' ? report : undefined;
}

export async function runRetryStep(opts: RetryStepOpts): Promise<RetryStepResult> {
  const { ctx, attempts, isolationRole } = opts;
  let { state, task } = opts;
  ({ task, state } = await refreshAndPersistCode(task, ctx, state, ctx.workspaceDir, 'retry'));

  state = rebaseOnPersistedWorkflowState(ctx, state);

  const invocationAttempt = Math.max(state.attempt, attempts);
  if (state.attempt !== invocationAttempt) {
    const saved = commitWorkflowState({
      ref: ctx,
      expected: loadState(ctx) === null ? null : state,
      next: { ...state, attempt: invocationAttempt },
    });
    if (saved.kind === 'conflict') throw stateOpsError.changedOnDisk(ctx.sessionId);
    if (saved.kind === 'durability-uncertain') {
      throw stateOpsError.durabilityUncertain(ctx.sessionId);
    }
    state = saved.state;
  }
  const workspace = await ctx.isolation.acquire({
    role: isolationRole ?? 'implementer',
    config: ctx.config,
    brief: { task, taskStartSnapshot: ctx.taskStartSnapshot },
  });
  const outcome = await runRetryStepAttempt({ ...opts, state, task }, workspace);
  return { ...outcome, attemptSnapshot: workspace.snapshot };
}

async function runRetryStepAttempt(
  opts: RetryStepOpts,
  workspace: AttemptWorkspace,
): Promise<RetryStepResult> {
  const { ctx, task, lastError, attempts, retryFailureFallback } = opts;
  const loop = await invokeRetryAttempt(opts, workspace);
  const retryResult = loop.value;
  let state = rebaseOnPersistedWorkflowState(ctx, loop.state);

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
          runner: retryResult.runner ?? ctx.config.implementer,
          ...(retryResult.transportError !== undefined && {
            transportError: retryResult.transportError,
          }),
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
  const report = doneReportOf(retryResult);
  if (report !== undefined) {
    state = transitionAndSave(ctx, state, {
      type: 'RECORD_DECISIONS',
      taskId: task.id,
      decisions: report.decisions,
    });
  }
  return validateAndCommitRetry({ ...opts, state }, workspace.snapshot);
}
