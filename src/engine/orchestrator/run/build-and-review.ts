import { resolveReviewCadence } from '../../../core/config/runtime/resolve.js';
import { reviewsAgain } from '../../../core/review/scope.js';
import type { Summary } from '../../../core/schemas/summary.js';
import { isTaskCompleted } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow/state.js';
import { haltRequiredChecksUnrunnable, runPreReview } from '../review/checks/gate.js';
import { type FollowedReview, reviewPassed, followReviewAnswer } from '../review/loop/follow.js';
import { haltVerdictlessReview } from '../review/loop/halts.js';
import { followPendingReview } from '../review/loop/scheduled.js';
import { runFinalReviewPhase } from '../review/phase.js';
import { recordFinalReviewStatus } from '../review/record.js';
import { transitionAndSave } from '../state-ops/transition.js';
import { buildSummary } from '../summary/build.js';
import { takeSeatChangeAtBoundary } from './boundary-park.js';
import { bindCandidate, captureCandidate, recheckCandidate } from './candidate.js';
import { runBriefs, runFixTasks } from './fix-tasks.js';
import { recheckMergedCandidate, buildIntegrationSection } from './integration-recheck.js';
import { recordRunSnapshotForRun } from './snapshots.js';
import type { BuildReviewRun, BuildReviewState } from './types.js';

type BuildReviewResult = { summary: Summary; completed: boolean; state: WorkflowState };

/** The build and the review on the recorded run workspace, while the project gate runs at the run base. */
export async function buildAndReview(
  args: BuildReviewRun & { state: WorkflowState },
): Promise<BuildReviewResult> {
  const { state, ...run } = args;
  const { wctx } = run;
  const shared: BuildReviewState = { state };
  const built = await runBriefs(run, shared);
  if (wctx.signal?.aborted) return stopRun(run, shared);

  // runFinalReviewPhase dispatches ALL_DONE (legal only from 'implementing') on a fresh
  // run; a resumed 'final-review' state (a previously failed gate) re-enters review
  // directly to retry it to completion. Any other phase short-circuits to the summary.
  const canRunFinalReview =
    shared.state.phase === 'implementing' || shared.state.phase === 'final-review';
  if (built !== 'complete' || !canRunFinalReview) return stopRun(run, shared);

  await recordRunSnapshotForRun({
    projectDir: wctx.projectDir,
    sessionId: wctx.sessionId,
    bus: wctx.bus,
    phase: shared.state.phase,
  });
  if (resolveReviewCadence(wctx.config) === 'none') return endWithoutReview(run, shared);
  return reviewUntilSettled(run, shared);
}

function stopRun(run: BuildReviewRun, shared: BuildReviewState): BuildReviewResult {
  return {
    summary: buildSummary({ ...run.summaryBase, state: shared.state }),
    completed: false,
    state: shared.state,
  };
}

function completeRun(run: BuildReviewRun, shared: BuildReviewState): BuildReviewResult {
  const summary = buildSummary({ ...run.summaryBase, state: shared.state });
  run.wctx.callbacks.onComplete(summary);
  return { summary, completed: true, state: shared.state };
}

/** Records the review status on the run and completes it. */
function closeReview(
  run: BuildReviewRun,
  shared: BuildReviewState,
  reviewStatus: 'none' | 'passed',
  candidate: Record<string, string> | undefined,
): BuildReviewResult {
  shared.state = transitionAndSave(run.ref, shared.state, {
    type: 'REVIEW_DONE',
    reviewStatus,
    ...(candidate !== undefined && { candidate }),
  });
  run.setTrackedState(shared.state);
  run.wctx.bus.publish({
    type: 'workflow_complete',
    ts: Date.now(),
    phase: shared.state.phase,
    review: reviewStatus,
    completedTasks: shared.state.tasks.filter((task) => isTaskCompleted(task.status)).length,
  });
  return completeRun(run, shared);
}

// REVIEW None ends here: the briefs ran their own checks and nothing else judges the result.
async function endWithoutReview(
  run: BuildReviewRun,
  shared: BuildReviewState,
): Promise<BuildReviewResult> {
  const { wctx } = run;
  if (wctx.signal?.aborted) return stopRun(run, shared);
  const candidate = await captureCandidate(wctx, shared.state);
  shared.state = (
    await recheckMergedCandidate({
      wctx,
      state: shared.state,
      setTrackedState: run.setTrackedState,
    })
  ).state;
  if (wctx.signal?.aborted) return stopRun(run, shared);
  bindCandidate(run, shared, candidate);
  recordFinalReviewStatus(wctx, 'skipped');
  return closeReview(run, shared, 'none', candidate);
}

// Each pass reviews the candidate and follows the answer. Fix tasks run before
// the next gates; corrections and answers to that cycle's final review re-review
// the same candidate.
async function reviewUntilSettled(
  run: BuildReviewRun,
  shared: BuildReviewState,
): Promise<BuildReviewResult> {
  const { wctx } = run;
  for (;;) {
    if (wctx.signal?.aborted) return stopRun(run, shared);
    const boundary = await takeSeatChangeAtBoundary({
      wctx,
      state: shared.state,
      setTrackedState: run.setTrackedState,
    });
    shared.state = boundary.state;
    if (boundary.stopped) return stopRun(run, shared);
    const candidate = await captureCandidate(wctx, shared.state);
    const next = await reviewPass(run, shared, candidate);
    if (next === 'stop') return stopRun(run, shared);
    if (next === 'accepted') return completeRun(run, shared);
    if (next === 'passed') return closeReview(run, shared, 'passed', candidate);
    if (next === 'fix' && !(await runFixTasks(run, shared))) return stopRun(run, shared);
  }
}

/** Follows the pending answer of the last review, or reviews the candidate and follows its answer. */
async function reviewPass(
  run: BuildReviewRun,
  shared: BuildReviewState,
  candidate: Record<string, string> | undefined,
): Promise<FollowedReview['next'] | 'passed'> {
  const { wctx, setTrackedState } = run;
  const { callbacks } = wctx;
  const answered = await followPendingReview({
    wctx,
    state: shared.state,
    setTrackedState,
    callbacks,
    candidate,
  });
  if (answered !== undefined) {
    shared.state = answered.state;
    return answered.next;
  }
  const reviewAgain = reviewsAgain(shared.state, 'final');
  const recheck = await recheckCandidate(run, shared, reviewAgain);
  bindCandidate(run, shared, candidate);
  if (recheck.unrunnable.length > 0) {
    shared.state = haltRequiredChecksUnrunnable({
      wctx,
      state: shared.state,
      checks: recheck.unrunnable,
      setTrackedState,
    });
    return 'stop';
  }
  const review = await runReview(run, shared, reviewAgain, recheck);
  if (wctx.signal?.aborted || review.preReview === 'stopped') return 'stop';

  // A review that judged nothing is not a review that failed: it has no
  // blocker count to report, no brief to send back and no repair cycle to
  // spend. The run stays on this phase, halted on the review seat, until that
  // seat is answered — a fabricated `0 blocking findings` would close it.
  const halted = await haltVerdictlessReview({
    wctx,
    state: shared.state,
    setTrackedState,
    review,
  });
  if (halted !== undefined) {
    shared.state = halted;
    return 'stop';
  }
  const pendingInputs = shared.state.pendingTriage?.inputs ?? [];
  if (reviewPassed(review.verdict?.outcome, review.fixWork, pendingInputs)) return 'passed';
  const followed = await followReviewAnswer({
    wctx,
    state: shared.state,
    setTrackedState,
    callbacks,
    candidate,
    fixWork: review.fixWork,
  });
  shared.state = followed.state;
  return followed.next;
}

/**
 * Runs the final review of the candidate on the state of the run. The pre-review gates and the
 * reviewer checks run only on a new candidate.
 */
async function runReview(
  run: BuildReviewRun,
  shared: BuildReviewState,
  reviewAgain: boolean,
  recheck: { failures: string[]; notRun: string[] },
) {
  const { wctx, setTrackedState } = run;
  const { applyReview } = shared.state;
  const integration =
    applyReview === undefined
      ? undefined
      : buildIntegrationSection(applyReview.merged, recheck.failures, recheck.notRun);
  const review = await runFinalReviewPhase({
    projectDir: wctx.projectDir,
    workspaceDir: wctx.workspaceDir,
    sessionId: wctx.sessionId,
    config: wctx.config,
    callbacks: wctx.callbacks,
    bus: wctx.bus,
    steering: wctx.steering,
    state: shared.state,
    reviewer: wctx.reviewer,
    metadata: wctx.metadata,
    modelCache: wctx.modelCache,
    signal: wctx.signal,
    sinks: wctx.sinks,
    ...(wctx.continuation !== undefined && { continuation: wctx.continuation }),
    summaryBase: run.summaryBase,
    setTrackedState,
    ...(wctx.context.skillsContext !== undefined && {
      skillsContext: wctx.context.skillsContext,
    }),
    ...(integration !== undefined && { integration }),
    ...(!reviewAgain && {
      preReview: (s: WorkflowState) => runPreReview({ wctx, state: s, setTrackedState }),
    }),
    ...(!reviewAgain && { reviewChecks: { baseGate: wctx.baseGate } }),
  });
  shared.state = review.state;
  setTrackedState(shared.state);
  return review;
}
