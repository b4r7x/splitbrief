import type { Task, WorkflowState, ValidationResult, TaskTokenUsage, TaskCompletionMethod } from '../../types.js';
import { validateTask, formatValidationError } from './validator.js';
import { discardTaskChanges } from '../../utils/git.js';
import type { WorkflowContext } from './run.js';
import { emit, emitValidationStart, emitValidationProgress, emitValidationResult, createTextHandler } from './events.js';
import { refreshCurrentCode, addUsageAndSave, transitionAndSave } from './helpers.js';
import { validateCommitAndAdvance } from './task-runner.js';

type RetryResult = { completed: boolean; method: TaskTokenUsage['method'] };

type EscalationContext = WorkflowContext & { task: Task; taskStartTime?: number | undefined };

async function validateAndCommit(
  ctx: EscalationContext, state: WorkflowState,
  method: TaskCompletionMethod,
  transitionType: 'VALIDATION_PASS' | 'HINT_SUCCESS' | 'FULL_SUCCESS',
  commitSuffix?: string,
): Promise<{ state: WorkflowState; completed: boolean; validationResults: ValidationResult[] }> {
  const valStart = Date.now();
  emitValidationStart(ctx.callbacks);
  const validationResults = await validateTask(ctx.task, ctx.projectDir, ctx.config, (stages) => {
    emitValidationProgress(ctx.callbacks, stages, valStart);
  });
  emitValidationResult(ctx.callbacks, validationResults, valStart);
  const result = await validateCommitAndAdvance({
    task: ctx.task, results: validationResults, projectDir: ctx.projectDir, config: ctx.config,
    state, callbacks: ctx.callbacks, method, transitionType, commitSuffix, taskStartTime: ctx.taskStartTime,
  });
  return { ...result, validationResults };
}

async function runLocalRetries(
  ctx: EscalationContext, initialState: WorkflowState, initialError: string,
): Promise<{ state: WorkflowState; lastError: string; result?: RetryResult }> {
  let state = initialState;
  let lastError = initialError;
  const maxRetries = ctx.config.workflow.maxRetries;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    state = transitionAndSave(ctx.projectDir, state, { type: 'VALIDATION_FAIL' }, maxRetries);
    ctx.callbacks.onEvent({ type: 'retry', ts: Date.now(), taskId: ctx.task.id, attempt, maxRetries });
    emit(ctx.projectDir, state, 'task_retry', ctx.task.id, { attempt, error: lastError });

    refreshCurrentCode(ctx.task, ctx.projectDir);

    const retryResult = await ctx.implementer.retry({
      task: ctx.task, projectDir: ctx.projectDir, config: ctx.config, context: ctx.context,
      error: lastError, attempt,
      onProgress: createTextHandler(ctx.callbacks), onEvent: ctx.callbacks.onEvent,
    });
    state = addUsageAndSave(ctx.projectDir, state, 'implementer', retryResult.usage, ctx.callbacks);

    if (!retryResult.success) {
      lastError = retryResult.error ?? 'Retry failed to produce valid code';
      continue;
    }

    const commitResult = await validateAndCommit(ctx, state, 'local', 'VALIDATION_PASS');
    if (commitResult.completed) {
      return { state: commitResult.state, lastError, result: { completed: true, method: 'local' } };
    }
    lastError = formatValidationError(commitResult.validationResults);
  }

  return { state, lastError };
}

async function runTier1Hint(
  ctx: EscalationContext, state: WorkflowState, lastError: string,
): Promise<{ state: WorkflowState; lastError: string; result?: RetryResult }> {
  state = transitionAndSave(ctx.projectDir, state, { type: 'ESCALATE' });
  ctx.callbacks.onEvent({ type: 'planner-status', ts: Date.now(), phase: state.phase, status: 'running' });
  emit(ctx.projectDir, state, 'task_escalating', ctx.task.id);

  ctx.callbacks.onEvent({ type: 'escalate', ts: Date.now(), tier: 1 });
  const tier1Result = await ctx.planner.escalateHint(ctx.task, lastError, ctx.projectDir, {
    onOutput: createTextHandler(ctx.callbacks),
  });
  state = addUsageAndSave(ctx.projectDir, state, 'escalation', tier1Result.usage, ctx.callbacks);

  if (tier1Result.output) {
    ctx.callbacks.onEvent({ type: 'planner-text', ts: Date.now(), text: tier1Result.output });
  }

  const hintError = `${lastError}\n\n## Hints from senior reviewer:\n${tier1Result.output}`;
  refreshCurrentCode(ctx.task, ctx.projectDir);

  const hintRetryResult = await ctx.implementer.retry({
    task: ctx.task, projectDir: ctx.projectDir, config: ctx.config, context: ctx.context,
    error: hintError, attempt: ctx.config.workflow.maxRetries + 1,
    onProgress: createTextHandler(ctx.callbacks), onEvent: ctx.callbacks.onEvent,
  });
  state = addUsageAndSave(ctx.projectDir, state, 'implementer', hintRetryResult.usage, ctx.callbacks);

  if (hintRetryResult.success) {
    const commitResult = await validateAndCommit(ctx, state, 'escalated-hint', 'HINT_SUCCESS', 'with hints');
    if (commitResult.completed) {
      return { state: commitResult.state, lastError, result: { completed: true, method: 'escalated-hint' } };
    }
    return { state, lastError: formatValidationError(commitResult.validationResults) };
  }

  return { state, lastError: hintRetryResult.error ?? 'Tier-1 hint retry failed to produce valid code' };
}

async function runTier2Full(
  ctx: EscalationContext, state: WorkflowState, lastError: string,
): Promise<{ state: WorkflowState; result: RetryResult }> {
  state = transitionAndSave(ctx.projectDir, state, { type: 'HINT_FAIL' });
  emit(ctx.projectDir, state, 'hint_failed', ctx.task.id);

  ctx.callbacks.onEvent({ type: 'escalate', ts: Date.now(), tier: 2 });
  const tier2Result = await ctx.planner.escalateFull(ctx.task, lastError, ctx.projectDir, {
    onOutput: createTextHandler(ctx.callbacks),
  });
  state = addUsageAndSave(ctx.projectDir, state, 'escalation', tier2Result.usage, ctx.callbacks);

  if (tier2Result.success) {
    const commitResult = await validateAndCommit(ctx, state, 'escalated-full', 'FULL_SUCCESS', 'escalated');
    if (commitResult.completed) {
      return { state: commitResult.state, result: { completed: true, method: 'escalated-full' } };
    }
  }

  state = transitionAndSave(ctx.projectDir, state, { type: 'FULL_FAIL' });
  ctx.task.status = 'failed';
  emit(ctx.projectDir, state, 'task_full_fail', ctx.task.id);
  try { await discardTaskChanges(ctx.projectDir, ctx.task.file, ctx.task.action); } catch (err) {
    ctx.callbacks.onEvent({ type: 'warning', ts: Date.now(), message: `Failed to discard changes for ${ctx.task.file}: ${err}` });
  }
  return { state, result: { completed: false, method: 'failed' } };
}

type HandleRetryOptions = {
  wctx: WorkflowContext;
  task: Task;
  initialError: string;
  currentState: WorkflowState;
  taskStartTime?: number;
};

export async function handleRetryAndEscalation(opts: HandleRetryOptions): Promise<RetryResult> {
  const { wctx, task, initialError, currentState, taskStartTime } = opts;
  const ctx: EscalationContext = { ...wctx, task, taskStartTime };

  const retries = await runLocalRetries(ctx, currentState, initialError);
  if (retries.result) return retries.result;

  const tier1 = await runTier1Hint(ctx, retries.state, retries.lastError);
  if (tier1.result) return tier1.result;

  const tier2 = await runTier2Full(ctx, tier1.state, tier1.lastError);
  return tier2.result;
}
