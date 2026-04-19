import type { Task } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { TaskCompletionMethod } from '../../../core/schemas/enums.js';
import type { TokenDelta } from '../../../core/schemas/tokens.js';
import { formatValidationError } from '../validation.js';
import type { WorkflowContext } from '../types.js';
import { refreshAndPersistCode, addUsageAndSave } from '../state-ops.js';
import { validateCommitAndAdvance } from '../task-commit.js';
import type { UsageCategory } from '../tokens.js';

export const MAX_HINT_ERROR_LENGTH = 4000;

export type RetryResult =
  | { completed: true; method: Exclude<TaskCompletionMethod, 'failed' | 'skipped'>; attempts: number }
  | { completed: false; method: 'failed'; attempts: number };

export type EscalationContext = WorkflowContext & { taskStartTime?: number | undefined };

export type RetryStepOutcome = {
  state: WorkflowState;
  task: Task;
  lastError: string;
  attempts: number;
  result?: RetryResult;
};

export type SuccessMethod = Exclude<TaskCompletionMethod, 'failed' | 'skipped'>;

export type RetryStepOpts = {
  ctx: EscalationContext;
  task: Task;
  state: WorkflowState;
  lastError: string;
  attempts: number;
  method: SuccessMethod;
  transitionType: 'VALIDATION_PASS' | 'HINT_SUCCESS' | 'FULL_SUCCESS';
  commitSuffix?: string | undefined;
  usageCategory: UsageCategory;
  retryFailureFallback: string;
  invokeRetry: (args: { task: Task; lastError: string; attempts: number }) => Promise<{ success: boolean; error?: string | undefined; usage?: TokenDelta | null | undefined }>;
  onValidationAfterRetryFail?: ((validationError: string) => void) | undefined;
};

export async function validateAndCommit(
  ctx: EscalationContext, task: Task, state: WorkflowState,
  method: TaskCompletionMethod,
  transitionType: 'VALIDATION_PASS' | 'HINT_SUCCESS' | 'FULL_SUCCESS',
  retryCount: number,
  commitSuffix?: string,
) {
  const validationResults = await ctx.validator.runValidation(task, ctx.projectDir, ctx.config, ctx.callbacks);
  const result = await validateCommitAndAdvance({
    task, projectDir: ctx.projectDir, sessionId: ctx.sessionId,
    config: ctx.config, callbacks: ctx.callbacks,
    state, method, transitionType, commitSuffix,
    taskStartTime: ctx.taskStartTime, retryCount,
    results: validationResults,
  });
  return { ...result, validationResults };
}

/**
 * Shared retry step: refresh code → invoke retry → record usage → (on success) validate+commit.
 * Callers provide tier-specific inputs (method, usage category, commit suffix, retry invocation).
 */
export async function runRetryStep(opts: RetryStepOpts): Promise<RetryStepOutcome> {
  const { ctx, state: initialState, lastError, attempts, method, transitionType, commitSuffix, usageCategory, retryFailureFallback, invokeRetry, onValidationAfterRetryFail } = opts;
  let state = initialState;
  let task = opts.task;

  ({ task, state } = await refreshAndPersistCode(task, ctx.projectDir, ctx.sessionId, state));

  const retryResult = await invokeRetry({ task, lastError, attempts });
  state = addUsageAndSave(ctx.projectDir, ctx.sessionId, state, usageCategory, retryResult.usage, ctx.callbacks);

  if (!retryResult.success) {
    return { state, task, lastError: retryResult.error ?? retryFailureFallback, attempts };
  }

  const commitResult = await validateAndCommit(ctx, task, state, method, transitionType, attempts, commitSuffix);
  if (commitResult.completed) {
    return {
      state: commitResult.state,
      task,
      lastError,
      attempts,
      result: { completed: true, method, attempts },
    };
  }

  const validationError = formatValidationError(commitResult.validationResults);
  onValidationAfterRetryFail?.(validationError);
  return { state: commitResult.state, task, lastError: validationError, attempts };
}
