import type { Task } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { buildProjectLanguageContext } from '../../spec/prompts/language-context.js';
import { createBusTextHandler, publishWarning, publishEscalate, publishEvent } from '../events.js';
import { transitionAndSave } from '../state-ops.js';
import { runRetryStep, type EscalationContext, type RetryResult } from './step.js';

export async function runTier2Full(
  ctx: EscalationContext, initialTask: Task, state: WorkflowState, lastError: string, priorAttempts: number,
): Promise<{ state: WorkflowState; result: RetryResult }> {
  const attempts = priorAttempts + 1;
  const textHandler = createBusTextHandler(ctx.bus, state.phase);
  state = transitionAndSave(ctx.projectDir, ctx.sessionId, state, { type: 'HINT_FAIL' });
  publishEvent(ctx.bus, { type: 'hint_failed', ts: Date.now(), phase: state.phase, taskId: initialTask.id });

  publishEscalate(ctx.bus, state.phase, initialTask.id, 2);
  const languageContext = buildProjectLanguageContext(ctx.projectDir, state.discoveredValidation?.language);

  const outcome = await runRetryStep({
    ctx, task: initialTask, state, lastError, attempts,
    method: 'escalated-full', transitionType: 'FULL_SUCCESS',
    commitSuffix: 'escalated',
    usageCategory: 'escalation',
    retryFailureFallback: 'Tier-2 escalation failed to produce valid code',
    invokeRetry: async ({ task: t, lastError: err, projectDir }) =>
      ctx.planner.escalateFull(t, err, projectDir, { onOutput: textHandler }, languageContext),
    onValidationAfterRetryFail: (validationError) => {
      publishWarning(ctx.bus, state.phase, `Tier-2 escalation produced code but validation failed: ${validationError}`);
    },
  });

  if (outcome.result) {
    return { state: outcome.state, result: outcome.result };
  }

  publishEvent(ctx.bus, { type: 'task_full_fail', ts: Date.now(), phase: outcome.state.phase, taskId: outcome.task.id });
  return { state: outcome.state, result: { completed: false, method: 'failed', attempts } };
}
