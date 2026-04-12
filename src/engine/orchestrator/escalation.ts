import type { Task, WorkflowState, TaskCompletionMethod, ApiImplementerConfig, Config } from '../../types.js';
import { hasApiBase } from '../../core/config/runner-config.js';
import { formatValidationError } from './validator.js';
import { discardTaskChanges } from './git-ops.js';
import type { WorkflowContext } from './run.js';
import { emit, createTextHandler, emitWarning, emitPlannerStatus, emitRetry, emitEscalate } from './events.js';
import { refreshAndPersistCode, addUsageAndSave, transitionAndSave, warnOnFailure, validateAndCommitTask } from './helpers.js';
import { createImplementer } from '../runners/factory.js';
import type { Implementer } from '../implementers/types.js';
import { getProviderBaseURL } from '../../core/providers/catalog.js';

const MAX_HINT_ERROR_LENGTH = 4000;

function getApiBase(config: Config): string | undefined {
  if (hasApiBase(config.implementer)) return config.implementer.apiBase;
  return undefined;
}

type RetryResult =
  | { completed: true; method: Exclude<TaskCompletionMethod, 'failed' | 'skipped'>; attempts: number }
  | { completed: false; method: 'failed'; attempts: number };

type EscalationContext = WorkflowContext & { taskStartTime?: number | undefined };

async function validateAndCommit(
  ctx: EscalationContext, task: Task, state: WorkflowState,
  method: TaskCompletionMethod,
  transitionType: 'VALIDATION_PASS' | 'HINT_SUCCESS' | 'FULL_SUCCESS',
  commitSuffix?: string,
) {
  return validateAndCommitTask({
    task, projectDir: ctx.projectDir, config: ctx.config, callbacks: ctx.callbacks,
    state, method, transitionType, commitSuffix, taskStartTime: ctx.taskStartTime,
  });
}

async function runLocalRetries(
  ctx: EscalationContext, initialTask: Task, initialState: WorkflowState, initialError: string,
): Promise<{ state: WorkflowState; task: Task; lastError: string; attempts: number; result?: RetryResult }> {
  let state = initialState;
  let task = initialTask;
  let lastError = initialError;
  let attempts = 0;
  const maxRetries = ctx.config.workflow.maxRetries;

  const textHandler = createTextHandler(ctx.callbacks);

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    attempts = attempt;
    state = transitionAndSave(ctx.projectDir, state, { type: 'VALIDATION_FAIL' }, maxRetries);
    emitRetry(ctx.callbacks, task.id, attempt, maxRetries);
    emit(ctx.projectDir, state, 'task_retry', task.id, { attempt, error: lastError });

    ({ task, state } = await refreshAndPersistCode(task, ctx.projectDir, state));

    const retryResult = await ctx.implementer.retry({
      task, projectDir: ctx.projectDir, config: ctx.config, context: ctx.context,
      error: lastError, attempt, kind: 'local',
      onOutput: textHandler, onEvent: ctx.callbacks.onEvent,
    });
    state = addUsageAndSave(ctx.projectDir, state, 'implementer', retryResult.usage, ctx.callbacks);

    if (!retryResult.success) {
      lastError = retryResult.error ?? 'Retry failed to produce valid code';
      continue;
    }

    const commitResult = await validateAndCommit(ctx, task, state, 'local', 'VALIDATION_PASS');
    if (commitResult.completed) {
      return { state: commitResult.state, task, lastError, attempts, result: { completed: true, method: 'local', attempts } };
    }
    lastError = formatValidationError(commitResult.validationResults);
  }

  return { state, task, lastError, attempts };
}

async function runTier0Intermediate(
  ctx: EscalationContext, initialTask: Task, state: WorkflowState, lastError: string, priorAttempts: number,
): Promise<{ state: WorkflowState; task: Task; lastError: string; attempts: number; result?: RetryResult }> {
  const escalation = ctx.config.escalation;
  if (!escalation?.intermediateProvider || escalation.enabled === false) {
    return { state, task: initialTask, lastError, attempts: priorAttempts };
  }

  const attempts = priorAttempts + 1;
  let task = initialTask;
  const textHandler = createTextHandler(ctx.callbacks);

  emitEscalate(ctx.callbacks, 0, undefined, escalation.intermediateProvider, escalation.intermediateModel ?? ctx.config.implementer.model);

  const resolvedApiBase = getProviderBaseURL(escalation.intermediateProvider);
  if (!resolvedApiBase) {
    emitWarning(ctx.callbacks, `Unknown intermediate provider "${escalation.intermediateProvider}" — falling back to current implementer endpoint`);
  }

  const currentApiBase = getApiBase(ctx.config);
  const effectiveApiBase = resolvedApiBase || currentApiBase;
  if (!effectiveApiBase) {
    emitWarning(ctx.callbacks, `Cannot escalate: no API base URL available for intermediate provider "${escalation.intermediateProvider}"`);
    return { state, task, lastError, attempts: priorAttempts };
  }

  const intermediateImplConfig: ApiImplementerConfig = {
    kind: 'api',
    provider: escalation.intermediateProvider,
    model: escalation.intermediateModel ?? ctx.config.implementer.model,
    apiBase: effectiveApiBase,
    contextLength: ctx.config.implementer.contextLength,
    temperature: ctx.config.implementer.temperature,
    timeout: ctx.config.implementer.timeout,
    customModels: ctx.config.implementer.customModels,
  };

  const intermediateConfig: Config = {
    ...ctx.config,
    implementer: intermediateImplConfig,
  };

  let intermediateImplementer: Implementer;
  try {
    intermediateImplementer = createImplementer(intermediateConfig);
  } catch (err) {
    emitWarning(ctx.callbacks, `Intermediate provider failed to initialize: ${err instanceof Error ? err.message : String(err)}`);
    return { state, task, lastError, attempts: priorAttempts };
  }

  ({ task, state } = await refreshAndPersistCode(task, ctx.projectDir, state));

  const retryResult = await intermediateImplementer.retry({
    task, projectDir: ctx.projectDir, config: intermediateConfig, context: ctx.context,
    error: lastError, attempt: attempts, kind: 'local',
    onOutput: textHandler, onEvent: ctx.callbacks.onEvent,
  });
  // Intermediate provider is implementer-class (cheap API), not planner-class.
  // Recording as 'implementer' avoids ~35x cost overstatement that occurs when
  // escalation tokens are priced at planner rates (e.g., DeepSeek $0.28 vs Claude $5).
  state = addUsageAndSave(ctx.projectDir, state, 'implementer', retryResult.usage, ctx.callbacks);

  if (!retryResult.success) {
    return { state, task, lastError: retryResult.error ?? 'Intermediate escalation failed', attempts };
  }

  const commitResult = await validateAndCommit(ctx, task, state, 'escalated-intermediate', 'VALIDATION_PASS', 'intermediate');
  if (commitResult.completed) {
    return { state: commitResult.state, task, lastError, attempts, result: { completed: true, method: 'escalated-intermediate', attempts } };
  }

  return { state: commitResult.state, task, lastError: formatValidationError(commitResult.validationResults), attempts };
}

async function runTier1Hint(
  ctx: EscalationContext, initialTask: Task, state: WorkflowState, lastError: string, priorAttempts: number,
): Promise<{ state: WorkflowState; task: Task; lastError: string; attempts: number; result?: RetryResult }> {
  const attempts = priorAttempts + 1;
  let task = initialTask;
  const textHandler = createTextHandler(ctx.callbacks);
  state = transitionAndSave(ctx.projectDir, state, { type: 'ESCALATE' });
  emitPlannerStatus(ctx.callbacks, state, 'running');
  emit(ctx.projectDir, state, 'task_escalating', task.id, {});

  emitEscalate(ctx.callbacks, 1);
  const tier1Result = await ctx.planner.escalateHint(task, lastError, ctx.projectDir, {
    onOutput: textHandler,
  });
  state = addUsageAndSave(ctx.projectDir, state, 'escalation', tier1Result.usage, ctx.callbacks);

  if (tier1Result.output) {
    textHandler(tier1Result.output);
  }

  let hintError = `${lastError}\n\n## Hints from senior reviewer:\n${tier1Result.output}`;
  if (hintError.length > MAX_HINT_ERROR_LENGTH) {
    hintError = hintError.slice(0, MAX_HINT_ERROR_LENGTH) + '...[truncated]';
  }
  ({ task, state } = await refreshAndPersistCode(task, ctx.projectDir, state));

  const hintRetryResult = await ctx.implementer.retry({
    task, projectDir: ctx.projectDir, config: ctx.config, context: ctx.context,
    error: hintError, attempt: attempts, kind: 'hint',
    onOutput: textHandler, onEvent: ctx.callbacks.onEvent,
  });
  state = addUsageAndSave(ctx.projectDir, state, 'implementer', hintRetryResult.usage, ctx.callbacks);

  if (hintRetryResult.success) {
    const commitResult = await validateAndCommit(ctx, task, state, 'escalated-hint', 'HINT_SUCCESS', 'with hints');
    if (commitResult.completed) {
      return { state: commitResult.state, task, lastError, attempts, result: { completed: true, method: 'escalated-hint', attempts } };
    }
    return { state: commitResult.state, task, lastError: formatValidationError(commitResult.validationResults), attempts };
  }

  return { state, task, lastError: hintRetryResult.error ?? 'Tier-1 hint retry failed to produce valid code', attempts };
}

async function runTier2Full(
  ctx: EscalationContext, task: Task, state: WorkflowState, lastError: string, priorAttempts: number,
): Promise<{ state: WorkflowState; result: RetryResult }> {
  const attempts = priorAttempts + 1;
  const textHandler = createTextHandler(ctx.callbacks);
  state = transitionAndSave(ctx.projectDir, state, { type: 'HINT_FAIL' });
  emit(ctx.projectDir, state, 'hint_failed', task.id, {});

  emitEscalate(ctx.callbacks, 2);
  const tier2Result = await ctx.planner.escalateFull(task, lastError, ctx.projectDir, {
    onOutput: textHandler,
  });
  state = addUsageAndSave(ctx.projectDir, state, 'escalation', tier2Result.usage, ctx.callbacks);

  if (tier2Result.success) {
    const commitResult = await validateAndCommit(ctx, task, state, 'escalated-full', 'FULL_SUCCESS', 'escalated');
    if (commitResult.completed) {
      return { state: commitResult.state, result: { completed: true, method: 'escalated-full', attempts } };
    }
    emitWarning(ctx.callbacks, `Tier-2 escalation produced code but validation failed: ${formatValidationError(commitResult.validationResults)}`);
  }

  state = transitionAndSave(ctx.projectDir, state, { type: 'FULL_FAIL' });
  emit(ctx.projectDir, state, 'task_full_fail', task.id, {});
  await warnOnFailure(ctx.callbacks, `discard changes for ${task.file}`, () =>
    discardTaskChanges(ctx.projectDir, task.file, task.action),
  );
  return { state, result: { completed: false, method: 'failed', attempts } };
}

type HandleRetryOptions = {
  wctx: WorkflowContext;
  task: Task;
  initialError: string;
  currentState: WorkflowState;
  taskStartTime?: number;
};

export async function handleRetryAndEscalation(opts: HandleRetryOptions): Promise<{ state: WorkflowState; result: RetryResult }> {
  const { wctx, task, initialError, currentState, taskStartTime } = opts;
  const ctx: EscalationContext = { ...wctx, taskStartTime };

  const retries = await runLocalRetries(ctx, task, currentState, initialError);
  if (retries.result) return { state: retries.state, result: retries.result };

  if (ctx.signal?.aborted) return { state: retries.state, result: { completed: false, method: 'failed', attempts: retries.attempts } };

  const tier0 = await runTier0Intermediate(ctx, retries.task, retries.state, retries.lastError, retries.attempts);
  if (tier0.result) return { state: tier0.state, result: tier0.result };

  if (ctx.signal?.aborted) return { state: tier0.state, result: { completed: false, method: 'failed', attempts: tier0.attempts } };

  const tier1 = await runTier1Hint(ctx, tier0.task, tier0.state, tier0.lastError, tier0.attempts);
  if (tier1.result) return { state: tier1.state, result: tier1.result };

  if (ctx.signal?.aborted) return { state: tier1.state, result: { completed: false, method: 'failed', attempts: tier1.attempts } };

  const tier2 = await runTier2Full(ctx, tier1.task, tier1.state, tier1.lastError, tier1.attempts);
  return { state: tier2.state, result: tier2.result };
}
