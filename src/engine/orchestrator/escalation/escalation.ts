import type { Task, WorkflowState } from '../../../core/types/state-actions.js';
import type { WorkflowContext } from '../types.js';
import { runLocalRetries } from './local.js';
import { runTier0Intermediate } from './intermediate.js';
import { runTier1Hint } from './hint.js';
import { runTier2Full } from './full.js';
import type { EscalationContext, RetryResult } from './step.js';

export type { EscalationContext, RetryResult } from './step.js';

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
