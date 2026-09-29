import type { Task } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { Summary } from '../../../core/schemas/summary.js';
import type { Phase } from '../../../core/schemas/enums.js';
import type { StepRef } from '../../../core/schemas/run-step.js';
import type { WorkflowContext } from '../types.js';

import { buildSummary, type SummaryBase } from '../summary/build.js';
import { publishError } from '../events.js';
import { runTaskLoop } from '../task/loop.js';
import {
  REVIEW_UNAVAILABLE,
  runFinalReviewPhase,
  type FinalReviewFailure,
  type FinalReviewResult,
} from '../final-review.js';
import { decideReviewOutcome } from '../review-fix.js';
import { REVIEW_CYCLE_CAP } from '../../../core/pipeline-spec/review.js';
import { raisePendingRecovery, transitionAndSave } from '../state-ops.js';
import { buildReviewFailedRecoveryIssue } from '../recovery/builders/task.js';
import { nowIso } from '../../../utils/format-time.js';
import { ensureRunBaselineSnapshot, recordRunSnapshotForRun } from './snapshots.js';
import { PLAN_FILE, REVIEW_FILE, SPEC_FILE, TASKS_FILE } from '../../../core/paths.js';
import type { PlanningPhaseResult } from '../planning/types.js';

export type RunTasksAndReviewOptions = {
  wctx: WorkflowContext;
  state: WorkflowState;
  planning: PlanningPhaseResult;
  summaryBase: SummaryBase;
  phaseTimings: Record<string, number>;
  setTrackedState: (s: WorkflowState) => void;
  setCurrentTask: (t: Pick<Task, 'file' | 'files' | 'action'> | undefined) => void;
};

/**
 * Why this review reached no verdict, when it reached none. A result from before
 * the typed failure existed says only that nothing was written; that is a call
 * that did not land, carried under the one stable code rather than guessed at.
 */
function noVerdictFailure(review: FinalReviewResult): FinalReviewFailure | undefined {
  if (review.failure !== undefined) return review.failure;
  if (review.reviewStatus === 'written') return undefined;
  return {
    kind: 'call-failed',
    code: REVIEW_UNAVAILABLE,
    message: 'The final review reached no verdict, so nothing was judged.',
  };
}

export const APPROVAL_PARKED_ARTIFACT: Partial<Record<Phase, string>> = {
  'reviewing-spec': SPEC_FILE,
  'reviewing-plan': PLAN_FILE,
  'reviewing-briefs': TASKS_FILE,
};

/**
 * Pause after this brief, held in place. The state records the brief the run
 * will start next, so leaving the screen persists as a boundary park and the
 * run picks up there; `/resume` settles the promise and the loop carries on.
 */
async function parkAtBoundary(args: {
  wctx: WorkflowContext;
  state: WorkflowState;
  setTrackedState: (s: WorkflowState) => void;
}): Promise<{ state: WorkflowState; continued: boolean }> {
  const { wctx, setTrackedState } = args;
  const ref = { projectDir: wctx.projectDir, sessionId: wctx.sessionId };
  const onContinuationNeeded = wctx.callbacks.onContinuationNeeded;
  const nextTask = args.state.tasks[args.state.currentTaskIndex];
  const step: StepRef =
    nextTask === undefined
      ? { kind: 'review', cycle: args.state.reviewFixes?.cycle ?? 0 }
      : { kind: 'brief', taskId: nextTask.id, attempt: 0 };

  let state = transitionAndSave(ref, args.state, {
    type: 'INTERRUPT_STEP',
    step,
    source: 'user',
    cut: 'boundary',
  });
  setTrackedState(state);
  wctx.bus.publish({
    type: 'turn_interrupted',
    ts: Date.now(),
    phase: state.phase,
    source: 'user',
    at: 'boundary',
    step,
  });

  // No prompt surface means nothing can continue this run in place; the park is
  // recorded and the run ends, resumable at the brief it stopped before.
  if (onContinuationNeeded === undefined) return { state, continued: false };

  const steer = await onContinuationNeeded('', 'boundary');
  if (wctx.signal?.aborted) return { state, continued: false };
  state = transitionAndSave(ref, state, { type: 'RESUME_STEP' });
  setTrackedState(state);
  wctx.continuation?.hold(step, steer.trim() === '' ? undefined : steer);
  return { state, continued: true };
}

export async function runTasksAndReview(
  opts: RunTasksAndReviewOptions,
): Promise<{ summary: Summary; completed: boolean; cancelled: boolean; state: WorkflowState }> {
  const { wctx, phaseTimings, setTrackedState, setCurrentTask } = opts;
  const { summaryBase } = opts;
  let { state } = opts;
  const { callbacks } = wctx;
  const bail = () => ({
    summary: buildSummary({ ...summaryBase, state, phaseTimings }),
    completed: false,
    cancelled: false,
    state,
  });

  if (opts.planning.disposition !== 'ready-for-tasks') {
    return bail();
  }

  await ensureRunBaselineSnapshot({
    projectDir: wctx.projectDir,
    sessionId: wctx.sessionId,
    bus: wctx.bus,
    phase: state.phase,
  });

  const phaseStart = Date.now();
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
    const parked = await parkAtBoundary({ wctx, state, setTrackedState });
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

  phaseTimings.implementing = Date.now() - phaseStart;

  if (wctx.signal?.aborted) {
    return {
      summary: buildSummary({
        ...summaryBase,
        state,
        taskBreakdowns: taskResult.taskBreakdowns,
        phaseTimings,
      }),
      completed: false,
      cancelled: false,
      state,
    };
  }

  // runFinalReviewPhase dispatches ALL_DONE (legal only from 'implementing') on a fresh
  // run; a resumed 'final-review' state (a previously failed gate) re-enters review
  // directly to retry it to completion. Any other phase short-circuits to the summary.
  const canRunFinalReview = state.phase === 'implementing' || state.phase === 'final-review';
  if (taskResult.status !== 'complete' || !canRunFinalReview) {
    return {
      summary: buildSummary({
        ...summaryBase,
        state,
        taskBreakdowns: taskResult.taskBreakdowns,
        phaseTimings,
      }),
      completed: false,
      cancelled: taskResult.status === 'cancelled',
      state,
    };
  }

  await recordRunSnapshotForRun({
    projectDir: wctx.projectDir,
    sessionId: wctx.sessionId,
    bus: wctx.bus,
    phase: state.phase,
  });

  const ref = { projectDir: wctx.projectDir, sessionId: wctx.sessionId };
  let taskBreakdowns = taskResult.taskBreakdowns;
  const summaryNow = () => buildSummary({ ...summaryBase, state, taskBreakdowns, phaseTimings });

  // The review owns the run's exit: a `fail` it can attribute to briefs sends
  // those briefs back through implementation and asks again, up to the cap.
  // The budget is durable: a resumed final review restarts from the cycles its
  // earlier invocations already spent, so continuing never mints new ones.
  for (let cycle = state.reviewFixes?.cycle ?? 0; ; cycle++) {
    const review = await runFinalReviewPhase({
      projectDir: wctx.projectDir,
      sessionId: wctx.sessionId,
      config: wctx.config,
      callbacks,
      bus: wctx.bus,
      state,
      reviewer: wctx.reviewer,
      metadata: wctx.metadata,
      signal: wctx.signal,
      sinks: wctx.sinks,
      ...(wctx.continuation !== undefined && { continuation: wctx.continuation }),
      summaryBase,
      taskBreakdowns,
      phaseTimings,
      setTrackedState,
    });
    state = review.state;
    setTrackedState(state);
    if (wctx.signal?.aborted) {
      return { summary: summaryNow(), completed: false, cancelled: false, state };
    }

    // A review that judged nothing is not a review that failed: it has no
    // blocker count to report, no brief to send back and no repair cycle to
    // spend. The run stays on this phase, halted on the review seat, until that
    // seat is answered — a fabricated `0 blocking findings` would close it.
    const failure = noVerdictFailure(review);
    if (failure !== undefined) {
      const issue = buildReviewFailedRecoveryIssue({
        phase: state.phase,
        failure,
        createdAt: nowIso(),
      });
      publishError({
        bus: wctx.bus,
        phase: state.phase,
        message: issue.message,
        safety: { category: 'recovery', code: 'review_failed' },
      });
      state = raisePendingRecovery({ ...ref, bus: wctx.bus }, state, issue, setTrackedState);
      return { summary: summaryNow(), completed: false, cancelled: false, state };
    }

    const decision = decideReviewOutcome(review, state.tasks, REVIEW_CYCLE_CAP, cycle);
    if (decision.kind === 'pass') {
      state = transitionAndSave(ref, state, { type: 'REVIEW_DONE', reviewStatus: 'passed' });
      setTrackedState(state);
      wctx.bus.publish({
        type: 'workflow_complete',
        ts: Date.now(),
        phase: state.phase,
        review: 'passed',
      });
      const summary = summaryNow();
      callbacks.onComplete(summary);
      return { summary, completed: true, cancelled: false, state };
    }

    if (decision.kind === 'fail') {
      state = transitionAndSave(ref, state, { type: 'REVIEW_DONE', reviewStatus: 'failed' });
      setTrackedState(state);
      wctx.bus.publish({
        type: 'workflow_complete',
        ts: Date.now(),
        phase: state.phase,
        review: 'failed',
        blocking: decision.blocking,
      });
      publishError({
        bus: wctx.bus,
        phase: state.phase,
        message: `Final review failed with ${decision.blocking} blocking finding${decision.blocking === 1 ? '' : 's'}; see ${REVIEW_FILE}`,
        safety: { category: 'recovery', code: 'review_failed' },
      });
      state = raisePendingRecovery(
        { ...ref, bus: wctx.bus },
        state,
        buildReviewFailedRecoveryIssue({
          blocking: decision.blocking,
          phase: state.phase,
          createdAt: nowIso(),
        }),
        setTrackedState,
      );
      return { summary: summaryNow(), completed: false, cancelled: false, state };
    }

    const nextCycle = cycle + 1;
    state = transitionAndSave(ref, state, {
      type: 'REVIEW_FIX_START',
      fixes: decision.fixes,
      cycle: nextCycle,
    });
    setTrackedState(state);
    wctx.bus.publish({
      type: 'review_fix_started',
      ts: Date.now(),
      phase: state.phase,
      cycle: nextCycle,
      taskIds: state.tasks.filter((t) => decision.fixes[t.id] !== undefined).map((t) => t.id),
    });

    let rerun = await runTaskLoop({ wctx, initialState: state, setTrackedState, setCurrentTask });
    state = rerun.state;
    taskBreakdowns = rerun.taskBreakdowns;
    // A boundary pause inside a repair parks the run exactly like the main
    // loop: the park keeps the next brief or review step and the cycles
    // already spent, and continuing re-enters this same repair.
    while (rerun.status === 'paused') {
      const parked = await parkAtBoundary({ wctx, state, setTrackedState });
      state = parked.state;
      if (!parked.continued) break;
      rerun = await runTaskLoop({ wctx, initialState: state, setTrackedState, setCurrentTask });
      state = rerun.state;
      taskBreakdowns = rerun.taskBreakdowns;
    }
    if (rerun.status !== 'complete') {
      return {
        summary: summaryNow(),
        completed: false,
        cancelled: rerun.status === 'cancelled',
        state,
      };
    }
  }
}
