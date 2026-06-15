import type { Task } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { buildProjectLanguageContext } from '../../spec/prompts/language-context.js';
import { createBusTextHandler, publishRetry } from '../events.js';
import { transitionAndSave } from '../state-ops.js';
import { makeImplementerRetryInvoker } from './make-implementer-retry-invoker.js';
import { runRetryStep } from './step.js';
import type { EscalationContext, RetryStepOutcome } from './types.js';

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

  const textHandler = createBusTextHandler({ bus: ctx.bus, phase: state.phase }, 'implementer');

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    if (ctx.signal?.aborted) break;
    attempts = attempt;
    if (state.phase === 'implementing') {
      state = transitionAndSave(ctx, state, { type: 'TASK_SENT' });
    }
    state = transitionAndSave(ctx, state, { type: 'VALIDATION_FAIL' }, maxRetries);
    publishRetry({
      bus: ctx.bus,
      phase: state.phase,
      taskId: task.id,
      attempt,
      maxRetries,
      error: lastError,
    });
    if (state.phase === 'escalating') {
      break;
    }

    const outcome = await runRetryStep({
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

    state = outcome.state;
    task = outcome.task;
    lastError = outcome.lastError;
    if (outcome.result) {
      return outcome;
    }
  }

  return { state, task, lastError, attempts };
}
