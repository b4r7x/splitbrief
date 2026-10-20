import { acquireLiveness } from '../run/liveness.js';
import { finalizeRunAtRest } from '../session-lifecycle/finalize.js';
import { trackActiveApply } from '../session-lifecycle/shutdown.js';
import { runApply } from './run.js';

type AtRestApplyInput = Omit<Parameters<typeof runApply>[0], 'setTrackedState'>;

async function applyHoldingLiveness(
  input: AtRestApplyInput,
): Promise<Awaited<ReturnType<typeof runApply>>> {
  const releaseLiveness = await acquireLiveness({
    projectDir: input.wctx.projectDir,
    sessionId: input.wctx.sessionId,
    feature: input.state.feature,
  });
  try {
    const result = await runApply(input);
    if (
      result.outcome === 'applied' ||
      (result.outcome === 'halted' && result.state !== input.state)
    ) {
      finalizeRunAtRest({ ref: input.wctx, state: result.state });
    }
    return result;
  } finally {
    await releaseLiveness();
  }
}

/**
 * Apply on a run at rest. It holds the run's liveness for the whole call, so every reader sees the
 * run running and a second Apply is refused, and shutdown waits for it.
 */
export function runApplyAtRest(
  input: AtRestApplyInput,
): Promise<Awaited<ReturnType<typeof runApply>>> {
  return trackActiveApply(applyHoldingLiveness(input));
}
