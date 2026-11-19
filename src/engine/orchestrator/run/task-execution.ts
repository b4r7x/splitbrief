import type { WorkflowState } from '../../../core/schemas/workflow/state.js';
import type { Summary } from '../../../core/schemas/summary.js';

import { buildSummary } from '../summary/build.js';
import { runCodeDir } from '../kept-work.js';
import { startBaseGate } from '../validation/base-gate.js';
import type { RunTasksAndReviewOptions } from './types.js';
import { buildAndReview } from './build-and-review.js';
import { ensureRunWorkspace } from './workspace.js';

export async function runTasksAndReview(
  opts: RunTasksAndReviewOptions,
): Promise<{ summary: Summary; completed: boolean; state: WorkflowState }> {
  const { setTrackedState, setCurrentTask } = opts;
  const initialWctx = opts.wctx;
  const { summaryBase } = opts;
  let { state } = opts;
  const bail = () => ({
    summary: buildSummary({ ...summaryBase, state }),
    completed: false,
    state,
  });

  if (opts.planning.disposition !== 'ready-for-tasks') {
    return bail();
  }

  const ref = { projectDir: initialWctx.projectDir, sessionId: initialWctx.sessionId };
  state = await ensureRunWorkspace(ref, initialWctx, state);
  setTrackedState(state);
  const wctx = {
    ...initialWctx,
    workspaceDir: runCodeDir(initialWctx.projectDir, state.workspace),
  };
  let phase = state.phase;
  const trackState = (next: WorkflowState) => {
    phase = next.phase;
    setTrackedState(next);
  };
  const baseGate = startBaseGate({
    ref,
    workspaceDir: wctx.workspaceDir,
    config: wctx.config,
    bus: wctx.bus,
    state,
    phase: () => phase,
    signal: wctx.signal,
  });
  // The base run never outlives the run loop: it stops before the run's processes are killed, so a
  // killed base command is never stored as a red.
  try {
    return await buildAndReview({
      wctx: { ...wctx, baseGate },
      state,
      ref,
      summaryBase,
      setTrackedState: trackState,
      setCurrentTask,
    });
  } finally {
    await baseGate?.stop();
  }
}
