import type { WorkflowState } from '../../../core/schemas/workflow/state.js';
import { bindApplyHandOffs } from '../apply/hand-off.js';
import { captureReviewedCandidate } from '../apply/states.js';
import type { WorkflowContext } from '../types.js';
import { recheckMergedCandidate } from './integration-recheck.js';
import type { BuildReviewRun, BuildReviewState } from './types.js';

/** The files of the run workspace that the review judges. A checkout run has no candidate. */
export async function captureCandidate(
  wctx: WorkflowContext,
  state: WorkflowState,
): Promise<Record<string, string> | undefined> {
  const workspace = state.workspace;
  return workspace !== undefined &&
    (workspace.kind === 'worktree' || workspace.kind === 'staged-copy')
    ? captureReviewedCandidate({
        projectDir: wctx.projectDir,
        sessionId: wctx.sessionId,
        workspace,
      })
    : undefined;
}

/**
 * The Apply recheck that the review of the candidate reads. A review that runs again on the same
 * candidate reads the recheck the candidate already had.
 */
export async function recheckCandidate(
  run: BuildReviewRun,
  shared: BuildReviewState,
  reviewAgain: boolean,
) {
  if (reviewAgain) {
    return {
      failures: shared.state.applyReview?.failures ?? [],
      notRun: shared.state.applyReview?.notRun ?? [],
      unrunnable: [],
    };
  }
  const { state, ...recheck } = await recheckMergedCandidate({
    wctx: run.wctx,
    state: shared.state,
    setTrackedState: run.setTrackedState,
  });
  shared.state = state;
  return recheck;
}

/** Binds the files that Apply handed off to the entries of the candidate that the review judges. */
export function bindCandidate(
  run: BuildReviewRun,
  shared: BuildReviewState,
  candidate: Record<string, string> | undefined,
): void {
  if (candidate === undefined) return;
  shared.state = bindApplyHandOffs(run.ref, shared.state, candidate);
  run.setTrackedState(shared.state);
}
