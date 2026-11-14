import { resolveReviewCadence } from '../../../core/config/runtime/resolve.js';
import { reviewsAgain } from '../../../core/review/scope.js';
import type { Summary } from '../../../core/schemas/summary.js';
import { isTaskCompleted } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow/state.js';
import type { SessionRef } from '../../../core/types/session-ref.js';
import { bindApplyHandOffs } from '../apply/hand-off.js';
import { captureReviewedCandidate } from '../apply/states.js';
import { haltRequiredChecksUnrunnable, runPreReview } from '../review/checks/gate.js';
import { reviewPassed, followReviewAnswer } from '../review/loop/follow.js';
import { haltVerdictlessReview } from '../review/loop/halts.js';
import { followPendingReview } from '../review/loop/scheduled.js';
import { runFinalReviewPhase } from '../review/phase.js';
import { recordFinalReviewStatus } from '../review/record.js';
import { transitionAndSave } from '../state-ops/transition.js';
import { type SummaryBase, buildSummary } from '../summary/build.js';
import { runTaskLoop } from '../task/loop.js';
import type { WorkflowContext } from '../types.js';
import { parkAtBoundary, takeSeatChangeAtBoundary } from './boundary-park.js';
import { recheckMergedCandidate, buildIntegrationSection } from './integration-recheck.js';
import { recordRunSnapshotForRun } from './snapshots.js';
import type { RunTasksAndReviewOptions } from './types.js';

/** The build and the review on the recorded run workspace, while the project gate runs at the run base. */
export async function buildAndReview(args: {
  wctx: WorkflowContext;
  state: WorkflowState;
  ref: SessionRef;
  summaryBase: SummaryBase;
  setTrackedState: (s: WorkflowState) => void;
  setCurrentTask: RunTasksAndReviewOptions['setCurrentTask'];
}): Promise<{ summary: Summary; completed: boolean; state: WorkflowState }> {
  const { wctx, ref, summaryBase, setTrackedState, setCurrentTask } = args;
  const { callbacks } = wctx;
  let { state } = args;
  let taskResult = await runTaskLoop({
    wctx,
    initialState: state,
    setTrackedState,
    setCurrentTask,
  });
  state = taskResult.state;

  // Pause after this brief holds the run in place rather than ending it: the
  // operator continues into the next brief, or leaves and resumes later.
  while (taskResult.status === 'paused') {
    const parked = await parkAtBoundary({ wctx, state, park: taskResult.park, setTrackedState });
    state = parked.state;
    if (!parked.continued) break;
    taskResult = await runTaskLoop({
      wctx,
      initialState: state,
      setTrackedState,
      setCurrentTask,
    });
    state = taskResult.state;
  }

  if (wctx.signal?.aborted) {
    return {
      summary: buildSummary({ ...summaryBase, state }),
      completed: false,
      state,
    };
  }

  // runFinalReviewPhase dispatches ALL_DONE (legal only from 'implementing') on a fresh
  // run; a resumed 'final-review' state (a previously failed gate) re-enters review
  // directly to retry it to completion. Any other phase short-circuits to the summary.
  const canRunFinalReview = state.phase === 'implementing' || state.phase === 'final-review';
  if (taskResult.status !== 'complete' || !canRunFinalReview) {
    return {
      summary: buildSummary({ ...summaryBase, state }),
      completed: false,
      state,
    };
  }

  await recordRunSnapshotForRun({
    projectDir: wctx.projectDir,
    sessionId: wctx.sessionId,
    bus: wctx.bus,
    phase: state.phase,
  });

  const summaryNow = () => buildSummary({ ...summaryBase, state });
  const captureCandidate = async (): Promise<Record<string, string> | undefined> => {
    const workspace = state.workspace;
    return workspace !== undefined &&
      (workspace.kind === 'worktree' || workspace.kind === 'staged-copy')
      ? captureReviewedCandidate({
          projectDir: wctx.projectDir,
          sessionId: wctx.sessionId,
          workspace,
        })
      : undefined;
  };

  const stopHere = () => ({
    summary: summaryNow(),
    completed: false,
    state,
  });

  // Runs the appended fix tasks. A boundary pause inside a fix cycle parks the run
  // exactly like the main loop: the park keeps the next brief or review step, and
  // continuing re-enters it. Returns the stop result when the loop did not complete.
  const runFixTasks = async () => {
    const boundary = await takeSeatChangeAtBoundary({ wctx, state, setTrackedState });
    state = boundary.state;
    if (boundary.stopped) return stopHere();
    let rerun = await runTaskLoop({ wctx, initialState: state, setTrackedState, setCurrentTask });
    state = rerun.state;
    while (rerun.status === 'paused') {
      const parked = await parkAtBoundary({ wctx, state, park: rerun.park, setTrackedState });
      state = parked.state;
      if (!parked.continued) break;
      rerun = await runTaskLoop({ wctx, initialState: state, setTrackedState, setCurrentTask });
      state = rerun.state;
    }
    if (rerun.status === 'complete') return undefined;
    return {
      summary: summaryNow(),
      completed: false,
      state,
    };
  };

  const completeRun = () => {
    const summary = summaryNow();
    callbacks.onComplete(summary);
    return { summary, completed: true, state };
  };

  // REVIEW None ends here: the briefs ran their own checks and nothing else judges the result.
  if (resolveReviewCadence(wctx.config) === 'none') {
    if (wctx.signal?.aborted) return stopHere();
    const candidate = await captureCandidate();
    state = (await recheckMergedCandidate({ wctx, state, setTrackedState })).state;
    if (wctx.signal?.aborted) return stopHere();
    if (candidate !== undefined) {
      state = bindApplyHandOffs(ref, state, candidate);
      setTrackedState(state);
    }
    recordFinalReviewStatus(wctx, 'skipped');
    state = transitionAndSave(ref, state, {
      type: 'REVIEW_DONE',
      reviewStatus: 'none',
      ...(candidate !== undefined && { candidate }),
    });
    setTrackedState(state);
    wctx.bus.publish({
      type: 'workflow_complete',
      ts: Date.now(),
      phase: state.phase,
      review: 'none',
      completedTasks: state.tasks.filter((task) => isTaskCompleted(task.status)).length,
    });
    return completeRun();
  }

  // Each pass reviews the candidate and follows the answer. Fix tasks run before
  // the next gates; corrections and answers to that cycle's final review re-review
  // the same candidate.
  for (;;) {
    if (wctx.signal?.aborted) return stopHere();
    const boundary = await takeSeatChangeAtBoundary({ wctx, state, setTrackedState });
    state = boundary.state;
    if (boundary.stopped) return stopHere();
    const candidate = await captureCandidate();
    const answered = await followPendingReview({
      wctx,
      state,
      setTrackedState,
      callbacks,
      candidate,
    });
    if (answered !== undefined) {
      state = answered.state;
      if (answered.next === 'stop') return stopHere();
      if (answered.next === 'accepted') return completeRun();
      if (answered.next === 'fix') {
        const stopped = await runFixTasks();
        if (stopped !== undefined) return stopped;
      }
      continue;
    }
    const reviewAgain = reviewsAgain(state, 'final');
    // A review that runs again on the same candidate reads the recheck the candidate already had.
    const recheck = reviewAgain
      ? {
          state,
          failures: state.applyReview?.failures ?? [],
          notRun: state.applyReview?.notRun ?? [],
          unrunnable: [],
        }
      : await recheckMergedCandidate({ wctx, state, setTrackedState });
    state = recheck.state;
    if (candidate !== undefined) {
      state = bindApplyHandOffs(ref, state, candidate);
      setTrackedState(state);
    }
    if (recheck.unrunnable.length > 0) {
      state = haltRequiredChecksUnrunnable({
        wctx,
        state,
        checks: recheck.unrunnable,
        setTrackedState,
      });
      return stopHere();
    }
    const integration =
      state.applyReview === undefined
        ? undefined
        : buildIntegrationSection(state.applyReview.merged, recheck.failures, recheck.notRun);
    const review = await runFinalReviewPhase({
      projectDir: wctx.projectDir,
      workspaceDir: wctx.workspaceDir,
      sessionId: wctx.sessionId,
      config: wctx.config,
      callbacks,
      bus: wctx.bus,
      steering: wctx.steering,
      state,
      reviewer: wctx.reviewer,
      metadata: wctx.metadata,
      modelCache: wctx.modelCache,
      signal: wctx.signal,
      sinks: wctx.sinks,
      ...(wctx.continuation !== undefined && { continuation: wctx.continuation }),
      summaryBase,
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
    state = review.state;
    setTrackedState(state);
    if (wctx.signal?.aborted) return stopHere();

    if (review.preReview === 'stopped') return stopHere();

    // A review that judged nothing is not a review that failed: it has no
    // blocker count to report, no brief to send back and no repair cycle to
    // spend. The run stays on this phase, halted on the review seat, until that
    // seat is answered — a fabricated `0 blocking findings` would close it.
    const halted = await haltVerdictlessReview({ wctx, state, setTrackedState, review });
    if (halted !== undefined) {
      state = halted;
      return stopHere();
    }

    if (reviewPassed(review.verdict?.outcome, review.fixWork, state.pendingTriage?.inputs ?? [])) {
      state = transitionAndSave(ref, state, {
        type: 'REVIEW_DONE',
        reviewStatus: 'passed',
        ...(candidate !== undefined && { candidate }),
      });
      setTrackedState(state);
      wctx.bus.publish({
        type: 'workflow_complete',
        ts: Date.now(),
        phase: state.phase,
        review: 'passed',
        completedTasks: state.tasks.filter((task) => isTaskCompleted(task.status)).length,
      });
      return completeRun();
    }
    const followed = await followReviewAnswer({
      wctx,
      state,
      setTrackedState,
      callbacks,
      candidate,
      fixWork: review.fixWork,
    });
    state = followed.state;
    if (followed.next === 'stop') return stopHere();
    if (followed.next === 'accepted') return completeRun();
    if (followed.next === 'review') continue;

    const stopped = await runFixTasks();
    if (stopped !== undefined) return stopped;
  }
}
