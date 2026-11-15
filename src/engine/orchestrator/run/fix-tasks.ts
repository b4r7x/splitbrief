import { type TaskLoopResult, runTaskLoop } from '../task/loop.js';
import { parkAtBoundary, takeSeatChangeAtBoundary } from './boundary-park.js';
import type { BuildReviewRun, BuildReviewState } from './types.js';

/**
 * Runs the briefs from the current one and returns how the last task loop ended. A pause after a
 * brief holds the run in place rather than ending it: the park keeps the next brief or review
 * step, and the operator continues into it, or leaves and resumes later.
 */
export async function runBriefs(
  run: BuildReviewRun,
  shared: BuildReviewState,
): Promise<TaskLoopResult['status']> {
  const { wctx, setTrackedState, setCurrentTask } = run;
  let result = await runTaskLoop({
    wctx,
    initialState: shared.state,
    setTrackedState,
    setCurrentTask,
  });
  shared.state = result.state;
  while (result.status === 'paused') {
    const parked = await parkAtBoundary({
      wctx,
      state: shared.state,
      park: result.park,
      setTrackedState,
    });
    shared.state = parked.state;
    if (!parked.continued) break;
    result = await runTaskLoop({
      wctx,
      initialState: shared.state,
      setTrackedState,
      setCurrentTask,
    });
    shared.state = result.state;
  }
  return result.status;
}

/**
 * Runs the fix briefs that a review answer appended, after a seat change that waits at the
 * boundary. Returns false when the run stopped before every fix brief completed.
 */
export async function runFixTasks(run: BuildReviewRun, shared: BuildReviewState): Promise<boolean> {
  const boundary = await takeSeatChangeAtBoundary({
    wctx: run.wctx,
    state: shared.state,
    setTrackedState: run.setTrackedState,
  });
  shared.state = boundary.state;
  if (boundary.stopped) return false;
  return (await runBriefs(run, shared)) === 'complete';
}
