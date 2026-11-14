import { loadState } from '../../../core/state/persistence.js';
import { readImplementerReport, type ImplementerReport } from '../../../core/schemas/consult.js';
import {
  addUsageAndSave,
  rebaseOnPersistedWorkflowState,
  transitionAndSave,
} from '../state-ops.js';
import { refreshAndPersistCode } from '../task/refresh-code.js';
import { gateAttemptChanges } from '../task/attempt-gate.js';
import { getChangedFilesSinceSnapshot } from '../approval/file-snapshots/capture.js';
import { withContinuationLoop } from '../continuation.js';
import { briefContinuation, changedDeclaredFiles } from '../kept-work.js';
import { recordSteerCorrection } from '../queue/build-corrections.js';
import { persistRetryApprovalEvidence, recordRetryDenial } from './retry-evidence.js';
import { validateAndCommit } from './validate-and-commit.js';
import { boundedHandBack, failedRetry } from './types.js';
import type { RetryInvokeResult, RetryStepOpts, RetryStepOutcome } from './types.js';
import type { WorkflowState } from '../../../core/schemas/workflow/state.js';
import { recordedApiCreatedPaths } from '../evidence/task.js';
import { raiseApiApplyRecovery } from '../evidence/persistence.js';
import { isRecord } from '../../../utils/type-guards.js';
import { isResumableWorkspaceStop, settleThrownCall } from '../isolation/retention.js';
import type { AttemptWorkspace } from '../isolation/types.js';
import { commitWorkflowState, stateOpsError } from '../state-ops.js';
import { withAttemptRestoreScope } from '../task/restore-scope.js';

/** The direct writer's blocked report: the attempt stopped asking for a decision. */
export type BlockedReport = Extract<ImplementerReport, { status: 'blocked' }>;

/** The direct writer's done report: what it changed and the decisions it took. */
type DoneReport = Extract<ImplementerReport, { status: 'done' }>;

/**
 * A retry outcome, with the blocked report an attempt handed back when it
 * stopped to ask, or the user's answer to the brief gate's question.
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
  let loop: { state: WorkflowState; value: RetryInvokeResult };
  try {
    // A stop of this call parks the attempt; the steer continues it on the edits it already made.
    loop = await withContinuationLoop<RetryInvokeResult>({
      ctx: {
        projectDir: workspace.projectDir,
        sessionId: ctx.sessionId,
        persistRef: { projectDir: ctx.projectDir, sessionId: ctx.sessionId },
        callbacks: ctx.callbacks,
        bus: ctx.bus,
        signal: ctx.signal,
        sinks: ctx.sinks,
      },
      state,
      step: { kind: 'brief', taskId: task.id, attempt: state.attempt },
      onStateChange: (next) => {
        state = next;
      },
      body: async ({ signal, partial, steerInput, recordOutput }) => {
        if (steerInput !== undefined) {
          state = recordSteerCorrection({ ...ctx, state, taskId: task.id, message: steerInput });
        }
        const changed = await changedDeclaredFiles(
          workspace.projectDir,
          task,
          ctx.taskStartSnapshot,
        );
        const continuation = briefContinuation({ changed, partial });
        return withAttemptRestoreScope({
          ref: ctx,
          dir: workspace.projectDir,
          taskStartSnapshot: ctx.taskStartSnapshot,
          attemptSnapshot: workspace.snapshot,
          run: () =>
            invokeRetry({
              task,
              lastError,
              attempts: state.attempt,
              projectDir: workspace.projectDir,
              config: ctx.config,
              implementer: ctx.implementer,
              ...(ctx.implementerProfile !== undefined && {
                implementerProfile: ctx.implementerProfile,
              }),
              signal,
              sandboxEnv: workspace.sandboxEnv,
              fileIgnoreProjectDir: ctx.projectDir,
              changeDetection: workspace.changeDetection,
              createdByThisTask: recordedApiCreatedPaths(ctx, task, workspace.projectDir),
              deliversAnswer: opts.deliversAnswer,
              ...(continuation !== undefined && { continuation }),
              recordOutput,
              seat: { ref: ctx, state, usageCategory },
            }),
        });
      },
    });
  } catch (err) {
    await settleThrownCall(workspace, ctx.signal, err);
    throw err;
  }
  const retryResult = loop.value;
  state = rebaseOnPersistedWorkflowState(ctx, loop.state);
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
  const commitResult = await validateAndCommit({
    ctx,
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
    attemptSnapshot: workspace.snapshot,
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
        ...(commitResult.bookedFiles.length > 0 && { changedFiles: commitResult.bookedFiles }),
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
    attempts,
  };
}
