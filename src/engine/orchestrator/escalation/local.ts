import type { Task, WorkflowState } from '../../../core/types/state-actions.js';
import { createEventEmitter, createTextHandler, emitRetry } from '../events.js';
import { transitionAndSave } from '../state-ops.js';
import { runRetryStep, type EscalationContext, type RetryStepOutcome } from './step.js';

export async function runLocalRetries(
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
