import type { Task } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { ABORTED_OUTCOME_TEXT } from '../../implementers/pipeline/call-result.js';
import { buildProjectLanguageContext } from '../../spec/prompts/language-context.js';
import { createBusTextHandler, publishRetry } from '../events.js';
import { rebaseOnPersistedWorkflowState, transitionAndSave } from '../state-ops.js';
import { makeImplementerRetryInvoker } from './make-implementer-retry-invoker.js';
import { runRetryStep } from './step.js';
import { failedRetry, type EscalationContext, type RetryStepOutcome } from './types.js';

function isAbortedOutcome(lastError: string, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted) return true;
  return lastError === ABORTED_OUTCOME_TEXT;
}

export async function runLocalRetries(
  opts: Readonly<{
    ctx: EscalationContext;
    task: Task;
    state: WorkflowState;
    lastError: string;
  }>,
): Promise<RetryStepOutcome> {
  const { ctx } = opts;
  let state = opts.state;
  let task = opts.task;
  let lastError = opts.lastError;
  let attempts = 0;
  const maxRetries = ctx.config.workflow.maxRetries;

  const textHandler = createBusTextHandler(
    { bus: ctx.bus, phase: state.phase },
    { role: 'implementer' },
  );

  const persistTransition = (
    current: WorkflowState,
    action: Parameters<typeof transitionAndSave>[2],
    extra: Parameters<typeof transitionAndSave>[3] = undefined,
  ): WorkflowState =>
    transitionAndSave(ctx, current, action, {
      expectedRevision: current.stateRevision,
      ...extra,
    });

  if (isAbortedOutcome(lastError, ctx.signal)) {
    return { state, task, lastError, attempts, result: failedRetry(attempts) };
  }

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    if (ctx.signal?.aborted) break;
    attempts = attempt;
    const attemptBefore = state.attempt;
    if (state.phase === 'implementing') {
      state = persistTransition(state, { type: 'TASK_SENT' });
    }
    state = persistTransition(state, { type: 'VALIDATION_FAIL' }, { maxRetries });
    const retryRow = {
      bus: ctx.bus,
      phase: state.phase,
      taskId: task.id,
      attempt,
      maxRetries,
      error: lastError,
    };
    if (state.phase === 'escalating') {
      publishRetry(retryRow);
      break;
    }

    let outcome: RetryStepOutcome;
    try {
      outcome = await runRetryStep({
        ctx,
        task,
        state,
        lastError,
        attempts,
        method: 'local',
        transitionType: 'VALIDATION_PASS',
        usageCategory: 'implementer',
        retryFailureFallback: 'Retry failed to produce valid code',
        profileOverride: ctx.retryProfileOverride,
        invokeRetry: makeImplementerRetryInvoker({
          context: ctx.context,
          kind: 'local',
          languageContext: buildProjectLanguageContext(
            ctx.projectDir,
            state.discoveredValidation?.language,
          ),
          phase: state.phase,
          onOutput: textHandler,
        }),
      });
    } catch (err) {
      publishRetry(retryRow);
      throw err;
    }

    state = outcome.state;
    task = outcome.task;
    lastError = outcome.lastError;
    if (outcome.result === undefined && isAbortedOutcome(lastError, ctx.signal)) {
      attempts = attempt - 1;
      const merged = rebaseOnPersistedWorkflowState(ctx, state);
      state = persistTransition(
        { ...merged, attempt: attemptBefore },
        {
          type: 'MARK_INJECTING_NATIVE',
          id: '__workflow_retry_abort__',
          attempt: attemptBefore,
        },
      );
      state = { ...state, attempt: attemptBefore };
      return { state, task, lastError, attempts, result: failedRetry(attempts) };
    }
    publishRetry(retryRow);
    if (outcome.result) {
      return outcome;
    }
    // A signed-out or quota-exhausted runner fails every further attempt the
    // same way; stop burning retries and let the caller halt instead of
    // escalating.
    if (
      outcome.lastFailure?.outcome === 'unauthenticated' ||
      outcome.lastFailure?.outcome === 'usage-limit'
    ) {
      return outcome;
    }
  }

  return { state, task, lastError, attempts };
}
