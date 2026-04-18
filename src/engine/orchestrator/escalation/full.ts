import type { Task } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { discardTaskChanges } from '../../../lib/git.js';
import { createEventEmitter, createTextHandler, emitWarning, emitEscalate } from '../events.js';
import { transitionAndSave } from '../state-ops.js';
import { warnOnFailure } from '../signals.js';
import { runRetryStep, type EscalationContext, type RetryResult } from './step.js';

export async function runTier2Full(
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
