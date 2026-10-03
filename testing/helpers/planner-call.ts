import type { RunnerCallResult } from '../../src/engine/calls/types.js';
import type { Planner, PlannerCallbacks } from '../../src/engine/planners/types.js';
import { requireCompletedCall } from '../../src/engine/planners/require-completed-call.js';

/**
 * One planning call through the seat's typed-call binding, the way the planning session makes it.
 * The callbacks reach the backend whole, so the session handle callbacks a test passes still fire.
 */
export async function callPlanner(
  planner: Planner,
  opts: { projectDir: string; callbacks: PlannerCallbacks; prompt?: string | undefined },
): Promise<RunnerCallResult> {
  const { projectDir, callbacks } = opts;
  return requireCompletedCall(
    await planner
      .typedCall({ projectDir, seat: 'planner', callbacks })
      .invoke({ prompt: opts.prompt ?? 'test-feature' }),
  );
}
