import type { Task, Config, WorkflowState, OrchestratorCallbacks, ProjectContext, ValidationResult, TaskTokenUsage, TaskCompletionMethod } from '../../types.js';
import { transition } from '../../core/state.js';
import { saveState } from '../../core/state-persistence.js';
import { validateTask, formatValidationError } from '../validator.js';
import { discardTaskChanges } from '../../utils/git.js';
import type { PlannerBackend } from '../planners/types.js';
import type { ImplementerBackend } from '../implementers/types.js';
import { emit, emitValidationStart, emitValidationResult, createTextHandler } from './events.js';
import { refreshCurrentCode, addUsageAndSave } from './helpers.js';
import { validateCommitAndAdvance } from './task-runner.js';

type RetryResult = { completed: boolean; method: TaskTokenUsage['method'] };

type EscalationContext = {
  task: Task; projectDir: string; config: Config; context: ProjectContext;
  planner: PlannerBackend; callbacks: OrchestratorCallbacks; taskStartTime?: number;
  implementer: ImplementerBackend;
};

async function validateAndCommit(
  ctx: EscalationContext, state: WorkflowState,
  method: TaskCompletionMethod,
  transitionType: 'VALIDATION_PASS' | 'HINT_SUCCESS' | 'FULL_SUCCESS',
  commitSuffix?: string,
): Promise<{ state: WorkflowState; completed: boolean; validationResults: ValidationResult[] }> {
  const valStart = Date.now();
  emitValidationStart(ctx.callbacks);
  const validationResults = await validateTask(ctx.task, ctx.projectDir, ctx.config);
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
    state = transition(state, { type: 'VALIDATION_FAIL' }, maxRetries);
    saveState(ctx.projectDir, state);
    ctx.callbacks.onEvent({ type: 'retry', ts: Date.now(), taskId: ctx.task.id, attempt, maxRetries });
    emit(ctx.projectDir, state, 'task_retry', ctx.task.id, { attempt, error: lastError });

    if (ctx.task.action === 'modify' || ctx.task.action === 'create') {
      refreshCurrentCode(ctx.task, ctx.projectDir);
    }

    const retryResult = await ctx.implementer.retry({
      task: ctx.task, projectDir: ctx.projectDir, config: ctx.config, context: ctx.context,
      error: lastError, attempt,
      onProgress: createTextHandler(ctx.callbacks), onEvent: ctx.callbacks.onEvent,
    });
    state = addUsageAndSave(ctx.projectDir, state, 'implementer', retryResult.usage);

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
  state = transition(state, { type: 'ESCALATE' });
  saveState(ctx.projectDir, state);
  ctx.callbacks.onEvent({ type: 'planner-status', ts: Date.now(), phase: state.phase, status: 'running' });
  emit(ctx.projectDir, state, 'task_escalating', ctx.task.id);

  ctx.callbacks.onEvent({ type: 'escalate', ts: Date.now(), tier: 1 });
  const tier1Result = await ctx.planner.escalateHint(ctx.task, lastError, ctx.projectDir, {
    onOutput: createTextHandler(ctx.callbacks),
  });
  state = addUsageAndSave(ctx.projectDir, state, 'escalation', tier1Result.usage);

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
  state = addUsageAndSave(ctx.projectDir, state, 'implementer', hintRetryResult.usage);

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
  state = transition(state, { type: 'HINT_FAIL' });
  saveState(ctx.projectDir, state);
  emit(ctx.projectDir, state, 'hint_failed', ctx.task.id);

  ctx.callbacks.onEvent({ type: 'escalate', ts: Date.now(), tier: 2 });
  const tier2Result = await ctx.planner.escalateFull(ctx.task, lastError, ctx.projectDir, {
    onOutput: createTextHandler(ctx.callbacks),
  });
  state = addUsageAndSave(ctx.projectDir, state, 'escalation', tier2Result.usage);

  if (tier2Result.success) {
    const commitResult = await validateAndCommit(ctx, state, 'escalated-full', 'FULL_SUCCESS', 'escalated');
    if (commitResult.completed) {
      return { state: commitResult.state, result: { completed: true, method: 'escalated-full' } };
    }
  }

  state = transition(state, { type: 'FULL_FAIL' });
  saveState(ctx.projectDir, state);
  ctx.task.status = 'failed';
  emit(ctx.projectDir, state, 'task_full_fail', ctx.task.id);
  try { await discardTaskChanges(ctx.projectDir, ctx.task.file, ctx.task.action); } catch { /* best effort */ }
  return { state, result: { completed: false, method: 'failed' } };
}

type HandleRetryOptions = {
  task: Task;
  initialError: string;
  projectDir: string;
  config: Config;
  context: ProjectContext;
  planner: PlannerBackend;
  callbacks: OrchestratorCallbacks;
  currentState: WorkflowState;
  taskStartTime?: number;
  implementer: ImplementerBackend;
};

export async function handleRetryAndEscalation(opts: HandleRetryOptions): Promise<RetryResult> {
  const { task, initialError, projectDir, config, context, planner, callbacks, currentState, taskStartTime, implementer } = opts;
  const ctx: EscalationContext = { task, projectDir, config, context, planner, callbacks, taskStartTime, implementer };

  const retries = await runLocalRetries(ctx, currentState, initialError);
  if (retries.result) return retries.result;

  const tier1 = await runTier1Hint(ctx, retries.state, retries.lastError);
  if (tier1.result) return tier1.result;

  const tier2 = await runTier2Full(ctx, tier1.state, tier1.lastError);
  return tier2.result;
}
