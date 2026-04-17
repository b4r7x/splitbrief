import type { Task, WorkflowState } from '../../core/types/state-actions.js';
import type { ApiImplementerConfig, Config } from '../../core/types/config-options.js';
import type { TaskCompletionMethod, TokenDelta } from '../../core/types/summary.js';
import { hasApiBase } from '../../core/config/runner-config.js';
import { formatValidationError } from './validator.js';
import { discardTaskChanges } from './git-ops.js';
import type { WorkflowContext } from './types.js';
import { createEventEmitter, createTextHandler, emitWarning, emitPlannerStatus, emitRetry, emitEscalate } from './events.js';
import { refreshAndPersistCode, addUsageAndSave, transitionAndSave, warnOnFailure } from './helpers.js';
import { runValidationWithEvents } from './validator.js';
import { validateCommitAndAdvance } from './task-commit.js';
import type { UsageCategory } from './tokens.js';
import { createImplementer } from '../runners/factory.js';
import type { Implementer } from '../implementers/types.js';
import { getProviderBaseURL } from '../../core/providers/catalog.js';
import { toErrorMessage } from '../../utils/format-errors.js';
import { truncateByChars } from '../../utils/truncate.js';

const MAX_HINT_ERROR_LENGTH = 4000;

type RetryResult =
  | { completed: true; method: Exclude<TaskCompletionMethod, 'failed' | 'skipped'>; attempts: number }
  | { completed: false; method: 'failed'; attempts: number };

type EscalationContext = WorkflowContext & { taskStartTime?: number | undefined };

/** Outcome of a single retry step: a shared shape regardless of tier. */
type RetryStepOutcome = {
  state: WorkflowState;
  task: Task;
  lastError: string;
  attempts: number;
  /** Set when this step produced a successful, validated commit. */
  result?: RetryResult;
};

type SuccessMethod = Exclude<TaskCompletionMethod, 'failed' | 'skipped'>;

/** Inputs describing one tier-attempt's retry invocation. */
type RetryStepOpts = {
  ctx: EscalationContext;
  task: Task;
  state: WorkflowState;
  lastError: string;
  attempts: number;
  method: SuccessMethod;
  transitionType: 'VALIDATION_PASS' | 'HINT_SUCCESS' | 'FULL_SUCCESS';
  commitSuffix?: string | undefined;
  usageCategory: UsageCategory;
  /** Fallback error message when retry fails without a specific error. */
  retryFailureFallback: string;
  /** Invokes the actual retry (implementer / intermediate implementer / planner-hint wrapped) and returns success/error/usage. */
  invokeRetry: (args: { task: Task; lastError: string; attempts: number }) => Promise<{ success: boolean; error?: string | undefined; usage?: TokenDelta | null | undefined }>;
  /** Invoked with the validation error when retry succeeds but validation fails (lets tier 2 emit a warning). */
  onValidationAfterRetryFail?: ((validationError: string) => void) | undefined;
};

async function validateAndCommit(
  ctx: EscalationContext, task: Task, state: WorkflowState,
  method: TaskCompletionMethod,
  transitionType: 'VALIDATION_PASS' | 'HINT_SUCCESS' | 'FULL_SUCCESS',
  retryCount: number,
  commitSuffix?: string,
) {
  const validationResults = await runValidationWithEvents(task, ctx.projectDir, ctx.config, ctx.callbacks);
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
async function runRetryStep(opts: RetryStepOpts): Promise<RetryStepOutcome> {
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

async function runLocalRetries(
  ctx: EscalationContext, initialTask: Task, initialState: WorkflowState, initialError: string,
): Promise<RetryStepOutcome> {
  let state = initialState;
  let task = initialTask;
  let lastError = initialError;
  let attempts = 0;
  const maxRetries = ctx.config.workflow.maxRetries;

  const textHandler = createTextHandler(ctx.callbacks);
  const emitEv = createEventEmitter(ctx.projectDir, ctx.sessionId);

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    attempts = attempt;
    state = transitionAndSave(ctx.projectDir, ctx.sessionId, state, { type: 'VALIDATION_FAIL' }, maxRetries);
    emitRetry(ctx.callbacks, task.id, attempt, maxRetries);
    emitEv(state, 'task_retry', task.id, { attempt, error: lastError });

    const outcome = await runRetryStep({
      ctx, task, state, lastError, attempts,
      method: 'local', transitionType: 'VALIDATION_PASS',
      usageCategory: 'implementer',
      retryFailureFallback: 'Retry failed to produce valid code',
      invokeRetry: async ({ task: t, lastError: err, attempts: a }) =>
        ctx.implementer.retry({
          task: t, projectDir: ctx.projectDir, config: ctx.config, context: ctx.context,
          error: err, attempt: a, kind: 'local',
          onOutput: textHandler, onEvent: ctx.callbacks.onEvent,
        }),
    });

    state = outcome.state;
    task = outcome.task;
    lastError = outcome.lastError;
    if (outcome.result) {
      return outcome;
    }
  }

  return { state, task, lastError, attempts };
}

async function runTier0Intermediate(
  ctx: EscalationContext, initialTask: Task, state: WorkflowState, lastError: string, priorAttempts: number,
): Promise<RetryStepOutcome> {
  const escalation = ctx.config.escalation;
  if (!escalation?.intermediateProvider || escalation.enabled === false) {
    return { state, task: initialTask, lastError, attempts: priorAttempts };
  }

  const attempts = priorAttempts + 1;
  const textHandler = createTextHandler(ctx.callbacks);

  emitEscalate(ctx.callbacks, 0, undefined, escalation.intermediateProvider, escalation.intermediateModel ?? ctx.config.implementer.model);

  const resolvedApiBase = getProviderBaseURL(escalation.intermediateProvider);
  if (!resolvedApiBase) {
    emitWarning(ctx.callbacks, `Unknown intermediate provider "${escalation.intermediateProvider}" — falling back to current implementer endpoint`);
  }

  const currentApiBase = hasApiBase(ctx.config.implementer) ? ctx.config.implementer.apiBase : undefined;
  const effectiveApiBase = resolvedApiBase || currentApiBase;
  if (!effectiveApiBase) {
    emitWarning(ctx.callbacks, `Cannot escalate: no API base URL available for intermediate provider "${escalation.intermediateProvider}"`);
    return { state, task: initialTask, lastError, attempts: priorAttempts };
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
    emitWarning(ctx.callbacks, `Intermediate provider failed to initialize: ${toErrorMessage(err)}`);
    return { state, task: initialTask, lastError, attempts: priorAttempts };
  }

  // Intermediate provider is implementer-class (cheap API), not planner-class.
  // Recording as 'implementer' avoids ~35x cost overstatement that occurs when
  // escalation tokens are priced at planner rates (e.g., DeepSeek $0.28 vs Claude $5).
  return runRetryStep({
    ctx, task: initialTask, state, lastError, attempts,
    method: 'escalated-intermediate', transitionType: 'VALIDATION_PASS',
    commitSuffix: 'intermediate',
    usageCategory: 'implementer',
    retryFailureFallback: 'Intermediate escalation failed',
    invokeRetry: async ({ task: t, lastError: err, attempts: a }) =>
      intermediateImplementer.retry({
        task: t, projectDir: ctx.projectDir, config: intermediateConfig, context: ctx.context,
        error: err, attempt: a, kind: 'local',
        onOutput: textHandler, onEvent: ctx.callbacks.onEvent,
      }),
  });
}

async function runTier1Hint(
  ctx: EscalationContext, initialTask: Task, state: WorkflowState, lastError: string, priorAttempts: number,
): Promise<RetryStepOutcome> {
  const attempts = priorAttempts + 1;
  const textHandler = createTextHandler(ctx.callbacks);
  const emitEv = createEventEmitter(ctx.projectDir, ctx.sessionId);
  state = transitionAndSave(ctx.projectDir, ctx.sessionId, state, { type: 'ESCALATE' });
  emitPlannerStatus(ctx.callbacks, state, 'running');
  emitEv(state, 'task_escalating', initialTask.id, {});

  emitEscalate(ctx.callbacks, 1);
  const tier1Result = await ctx.planner.escalateHint(initialTask, lastError, ctx.projectDir, {
    onOutput: textHandler,
  });
  state = addUsageAndSave(ctx.projectDir, ctx.sessionId, state, 'escalation', tier1Result.usage, ctx.callbacks);

  if (tier1Result.output) {
    textHandler(tier1Result.output);
  }

  const hintError = truncateByChars(`${lastError}\n\n## Hints from senior reviewer:\n${tier1Result.output}`, MAX_HINT_ERROR_LENGTH);

  return runRetryStep({
    ctx, task: initialTask, state, lastError: hintError, attempts,
    method: 'escalated-hint', transitionType: 'HINT_SUCCESS',
    commitSuffix: 'with hints',
    usageCategory: 'implementer',
    retryFailureFallback: 'Tier-1 hint retry failed to produce valid code',
    invokeRetry: async ({ task: t, lastError: err, attempts: a }) =>
      ctx.implementer.retry({
        task: t, projectDir: ctx.projectDir, config: ctx.config, context: ctx.context,
        error: err, attempt: a, kind: 'hint',
        onOutput: textHandler, onEvent: ctx.callbacks.onEvent,
      }),
  });
}

async function runTier2Full(
  ctx: EscalationContext, initialTask: Task, state: WorkflowState, lastError: string, priorAttempts: number,
): Promise<{ state: WorkflowState; result: RetryResult }> {
  const attempts = priorAttempts + 1;
  const textHandler = createTextHandler(ctx.callbacks);
  const emitEv = createEventEmitter(ctx.projectDir, ctx.sessionId);
  state = transitionAndSave(ctx.projectDir, ctx.sessionId, state, { type: 'HINT_FAIL' });
  emitEv(state, 'hint_failed', initialTask.id, {});

  emitEscalate(ctx.callbacks, 2);

  const outcome = await runRetryStep({
    ctx, task: initialTask, state, lastError, attempts,
    method: 'escalated-full', transitionType: 'FULL_SUCCESS',
    commitSuffix: 'escalated',
    usageCategory: 'escalation',
    retryFailureFallback: 'Tier-2 escalation failed to produce valid code',
    invokeRetry: async ({ task: t, lastError: err }) =>
      ctx.planner.escalateFull(t, err, ctx.projectDir, { onOutput: textHandler }),
    onValidationAfterRetryFail: (validationError) => {
      emitWarning(ctx.callbacks, `Tier-2 escalation produced code but validation failed: ${validationError}`);
    },
  });

  if (outcome.result) {
    return { state: outcome.state, result: outcome.result };
  }

  state = transitionAndSave(ctx.projectDir, ctx.sessionId, outcome.state, { type: 'FULL_FAIL' });
  emitEv(state, 'task_full_fail', outcome.task.id, {});
  await warnOnFailure(ctx.callbacks, `discard changes for ${outcome.task.file}`, () =>
    discardTaskChanges(ctx.projectDir, outcome.task.file, outcome.task.action),
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
