import type { Task } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { saveState } from '../../../core/state/persistence.js';
import { ABORTED_OUTCOME_TEXT } from '../../implementers/pipeline/call-result.js';
import { buildProjectLanguageContext } from '../../spec/prompts/language-context.js';
import { createBusTextHandler, publishRetry } from '../events.js';
import { mergePersistedMessageQueue, transitionAndSave } from '../state-ops.js';
import { makeImplementerRetryInvoker } from './make-implementer-retry-invoker.js';
import { runRetryStep } from './step.js';
import { failedRetry, type EscalationContext, type RetryStepOutcome } from './types.js';

function isAbortedOutcome(lastError: string, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted) return true;
  return lastError === ABORTED_OUTCOME_TEXT;
}

export async function runLocalRetries(
  ctx: EscalationContext,
  initialTask: Task,
  initialState: WorkflowState,
  initialError: string,
): Promise<RetryStepOutcome> {
  let state = initialState;
  let task = initialTask;
  let lastError = initialError;
  let attempts = 0;
  const maxRetries = ctx.config.workflow.maxRetries;

  const textHandler = createBusTextHandler(
    { bus: ctx.bus, phase: state.phase },
    { role: 'implementer' },
  );

  if (isAbortedOutcome(lastError, ctx.signal)) {
    return { state, task, lastError, attempts, result: failedRetry(attempts) };
  }

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    if (ctx.signal?.aborted) break;
    attempts = attempt;
    const attemptBefore = state.attempt;
    if (state.phase === 'implementing') {
      state = transitionAndSave(ctx, state, { type: 'TASK_SENT' });
    }
    state = transitionAndSave(ctx, state, { type: 'VALIDATION_FAIL' }, maxRetries);
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
      state = { ...mergePersistedMessageQueue(ctx, state), attempt: attemptBefore };
      saveState(ctx, state);
      return { state, task, lastError, attempts, result: failedRetry(attempts) };
    }
    publishRetry(retryRow);
    if (outcome.result) {
      return outcome;
    }
  }

  return { state, task, lastError, attempts };
}
