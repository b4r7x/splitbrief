import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { buildProjectLanguageContext } from '../../spec/prompts/language-context.js';
import { createBusTextHandler, publishEscalate, publishWarning } from '../events.js';
import { transitionAndSave } from '../state-ops.js';
import { runRetryStep } from './step.js';
import { failedRetry, type RetryResult, type TierStepInput } from './types.js';

export async function runFullTier(
  input: TierStepInput,
): Promise<{ state: WorkflowState; result: RetryResult }> {
  const { ctx, task: initialTask, lastError, priorAttempts } = input;
  let state = input.state;
  const attempts = priorAttempts + 1;
  const textHandler = createBusTextHandler({ bus: ctx.bus, phase: state.phase });
  state = transitionAndSave(ctx, state, { type: 'HINT_FAIL' });
  ctx.bus.publish({
    type: 'hint_failed',
    ts: Date.now(),
    phase: state.phase,
    taskId: initialTask.id,
  });

  publishEscalate({ bus: ctx.bus, phase: state.phase, taskId: initialTask.id, tier: 2 });
  const languageContext = buildProjectLanguageContext(
    ctx.projectDir,
    state.discoveredValidation?.language,
  );

  const outcome = await runRetryStep({
    ctx,
    task: initialTask,
    state,
    lastError,
    attempts,
    method: 'escalated-full',
    transitionType: 'FULL_SUCCESS',
    commitSuffix: 'escalated',
    usageCategory: 'escalation',
    retryFailureFallback: 'Tier-2 escalation failed to produce valid code',
    isolationRole: 'planner',
    invokeRetry: async ({
      task: t,
      lastError: err,
      projectDir,
      signal,
      sandboxEnv,
      fileIgnoreProjectDir,
      changeDetection,
    }) =>
      ctx.planner.escalateFull({
        task: t,
        error: err,
        projectDir,
        callbacks: { onOutput: textHandler, signal },
        languageContext,
        sandboxEnv,
        fileIgnoreProjectDir,
        changeDetection,
      }),
    onValidationAfterRetryFail: (validationError) => {
      publishWarning({
        bus: ctx.bus,
        phase: state.phase,
        message: `Tier-2 escalation produced code but validation failed: ${validationError}`,
      });
    },
  });

  if (outcome.result) {
    return { state: outcome.state, result: outcome.result };
  }

  ctx.bus.publish({
    type: 'task_full_fail',
    ts: Date.now(),
    phase: outcome.state.phase,
    taskId: outcome.task.id,
  });
  return { state: outcome.state, result: failedRetry(attempts) };
}
