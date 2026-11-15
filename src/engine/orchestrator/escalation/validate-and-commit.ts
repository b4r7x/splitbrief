import type { Task } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow/state.js';
import type { ChangedFilesSnapshot } from '../../../core/schemas/workflow/changed-files.js';
import type { TaskCompletionMethod } from '../../../core/schemas/enums.js';
import { validateCommitAndAdvance } from '../task/commit.js';
import { runBriefGate } from '../task/gates/brief.js';
import { getChangedFilesSinceSnapshot } from '../approval/file-snapshots/changed-since.js';
import { failedRetry } from './types.js';
import type { EscalationContext, RetryStepOpts, RetryStepResult } from './types.js';

export type ValidateAndCommitOptions = {
  ctx: EscalationContext;
  task: Task;
  state: WorkflowState;
  method: TaskCompletionMethod;
  transitionType: 'VALIDATION_PASS';
  retryCount: number;
  commitSuffix?: string | undefined;
  preApprovedChangedFiles: string[];
  attemptSnapshot: ChangedFilesSnapshot;
};

export async function validateAndCommit(opts: ValidateAndCommitOptions) {
  const { ctx, task, method, transitionType, retryCount, commitSuffix } = opts;
  const { preApprovedChangedFiles } = opts;
  let state = opts.state;
  if (ctx.signal?.aborted) {
    return {
      state,
      completed: false,
      blockedReason: 'aborted',
    };
  }

  const gated = await runBriefGate({
    wctx: ctx,
    task,
    state,
    changedFiles: preApprovedChangedFiles,
    taskStartSnapshot: ctx.taskStartSnapshot,
    attemptSnapshot: opts.attemptSnapshot,
  });
  state = gated.state;
  const { acceptance } = gated;
  if (gated.stop !== undefined) return { state, completed: false, blockedReason: gated.stop };
  if (gated.correction) return { state, completed: false, answer: gated.error };
  const result = await validateCommitAndAdvance({
    task,
    projectDir: ctx.projectDir,
    workspaceDir: ctx.workspaceDir,
    sessionId: ctx.sessionId,
    taskStartSnapshot: ctx.taskStartSnapshot,
    config: ctx.config,
    bus: ctx.bus,
    state,
    method,
    transitionType,
    commitSuffix,
    retryCount,
    implementerProfile: ctx.implementerProfile,
    acceptance,
    taskChangedFiles: preApprovedChangedFiles,
  });
  return {
    ...result,
    error: gated.error,
  };
}

/**
 * The end of a retry attempt whose changes passed the gate: the brief gate's checks, then the
 * commit. A message the user sent during green checks is the answer the next attempt delivers. A
 * stop of the gate ends the ladder: a skip for a `pre_validation` denial, a failed retry for every
 * other stop. A failed check is the error the ladder goes on with.
 */
export async function validateAndCommitRetry(
  opts: RetryStepOpts,
  attemptSnapshot: ChangedFilesSnapshot,
): Promise<RetryStepResult> {
  const { ctx, task, lastError, attempts, method, resultTool, resultModel } = opts;
  const commitResult = await validateAndCommit({
    ctx,
    task,
    state: opts.state,
    method,
    transitionType: opts.transitionType,
    retryCount: attempts,
    commitSuffix: opts.commitSuffix,
    preApprovedChangedFiles: await getChangedFilesSinceSnapshot(
      ctx.workspaceDir,
      ctx.taskStartSnapshot,
    ),
    attemptSnapshot,
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

  opts.onValidationAfterRetryFail?.(commitResult.error);
  return {
    state: commitResult.state,
    task,
    lastError: commitResult.error,
    attempts,
  };
}
