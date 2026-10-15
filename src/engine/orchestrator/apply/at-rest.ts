import type { Config } from '../../../core/schemas/config.js';
import { finalizeRunAtRest } from '../session-lifecycle/finalize.js';
import { runApply } from './run.js';

export async function runApplyAtRest(
  input: Omit<Parameters<typeof runApply>[0], 'setTrackedState'> & { config: Config },
): Promise<Awaited<ReturnType<typeof runApply>>> {
  const result = await runApply(input);
  if (
    result.outcome === 'applied' ||
    (result.outcome === 'halted' && result.state !== input.state)
  ) {
    finalizeRunAtRest({ ref: input.wctx, config: input.config, state: result.state });
  }
  return result;
}
