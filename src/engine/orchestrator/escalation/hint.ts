import type { Task } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { createEventEmitter, createTextHandler, emitPlannerStatus, emitEscalate } from '../events.js';
import { transitionAndSave, addUsageAndSave } from '../state-ops.js';
import { truncateByChars } from '../../../utils/truncate.js';
import { runRetryStep, MAX_HINT_ERROR_LENGTH, type EscalationContext, type RetryStepOutcome } from './step.js';

export async function runTier1Hint(
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
