import type { Task } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { buildProjectLanguageContext } from '../../spec/prompts/language-context.js';
import { createBusTextHandler, publishRetry } from '../events.js';
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

  const textHandler = createBusTextHandler(ctx.bus, state.phase);

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    attempts = attempt;
    state = transitionAndSave(ctx.projectDir, ctx.sessionId, state, { type: 'VALIDATION_FAIL' }, maxRetries);
    publishRetry(ctx.bus, state.phase, task.id, attempt, maxRetries, lastError);

    const outcome = await runRetryStep({
      ctx, task, state, lastError, attempts,
      method: 'local', transitionType: 'VALIDATION_PASS',
      usageCategory: 'implementer',
      retryFailureFallback: 'Retry failed to produce valid code',
      profileOverride: ctx.retryProfileOverride,
      invokeRetry: async ({ task: t, lastError: err, attempts: a, projectDir, implementer, config }) =>
        implementer.retry({
          task: t, projectDir, config, context: ctx.context,
          languageContext: buildProjectLanguageContext(ctx.projectDir, state.discoveredValidation?.language),
          error: err, attempt: a, kind: 'local',
          onOutput: textHandler,
          bus: ctx.bus,
          phase: state.phase,
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
