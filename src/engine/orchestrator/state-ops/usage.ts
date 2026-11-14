import type { TokenDelta } from '../../../core/schemas/tokens.js';
import type { WorkflowState } from '../../../core/schemas/workflow/state.js';
import { publishCostUpdate } from '../publish/runner.js';
import { type UsageCategory, addUsage } from '../tokens.js';
import { mutateState } from './commit.js';
import type { StateOperationContext, StateMutationOptions } from './errors.js';

export function addUsageAndSave(
  ctx: StateOperationContext,
  state: WorkflowState,
  category: UsageCategory,
  usage: TokenDelta | null | undefined,
  options?: StateMutationOptions,
): WorkflowState {
  if (!usage) return state;
  const mutationOptions =
    options ??
    (ctx.expectedRevision === undefined && ctx.conflictRetries === undefined
      ? undefined
      : {
          expectedRevision: ctx.expectedRevision,
          conflictRetries: ctx.conflictRetries,
        });
  const next = mutateState({
    ref: ctx,
    state,
    operation: 'usage',
    options: mutationOptions,
    rederivable: true,
    mergeQueue: true,
    derive: (base) => addUsage(base, category, usage),
  });
  publishCostUpdate({ bus: ctx.bus, phase: next.phase }, next.tokenUsage);
  return next;
}
