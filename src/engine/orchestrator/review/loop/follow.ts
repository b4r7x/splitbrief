import { redChecksOf } from '../../../../core/review/accepted.js';
import { writeAcceptedReview } from '../../../../core/review/store.js';
import { stuckTarget } from '../../../../core/review/stuck.js';
import {
  type ReviewOutcome,
  blockingRedInputs,
  reviewOutcomeOf,
  openFindings,
  blockingEntries,
  blockingKeys,
} from '../../../../core/review/verdict.js';
import type { TriageResult, TriageInput } from '../../../../core/schemas/review/verdict.js';
import { isTaskCompleted } from '../../../../core/schemas/task.js';
import type { ReviewRecord } from '../../../../core/schemas/workflow/review-record.js';
import type { WorkflowState } from '../../../../core/schemas/workflow/state.js';
import { fixCyclesOf } from '../../../../core/state/selectors.js';
import { sameFailure } from '../../../../core/state/progress.js';
import { error } from '../../../../utils/error.js';
import { transitionAndSave } from '../../state-ops/transition.js';
import type { WorkflowContext, OrchestratorCallbacks } from '../../types.js';
import { applyTriage, startFixCycle } from '../triage.js';
import { followReviewQuestion } from './ask.js';
import { haltFailedReview } from './halts.js';
import { askPlannerOnStuckReview } from './stuck.js';

export function reviewPassed(
  outcome: ReviewOutcome | undefined,
  fixWork: TriageResult | null,
  pendingInputs: readonly TriageInput[],
): boolean {
  return (
    outcome !== undefined &&
    outcome.kind !== 'fail' &&
    fixWork !== null &&
    fixWork.fixTasks.length === 0 &&
    fixWork.ask === null &&
    blockingRedInputs(pendingInputs, fixWork).length === 0
  );
}

/**
 * Where a followed review answer leaves the run: stopped, reviewing the same candidate again,
 * running the fix cycle it started, or with the planner's Accept as is.
 */
export type FollowedReview = Readonly<{
  state: WorkflowState;
  next: 'stop' | 'review' | 'fix' | 'accepted';
}>;

/**
 * The planner's Accept as is of a stuck review: the blockers stay open with the planner's note, a
 * final review closes as failed and a scheduled review clears, so the next brief starts. No red
 * check blocks here, because the contract refuses this accept while one does; your accept at a halt
 * is the one that records red checks. `review.md` names the planner and the note.
 */
function acceptStuckReview(args: {
  wctx: WorkflowContext;
  state: WorkflowState;
  setTrackedState: (s: WorkflowState) => void;
  candidate: Record<string, string> | undefined;
  judged: ReviewRecord;
  note: string;
}): WorkflowState {
  const { wctx, judged } = args;
  const ref = { projectDir: wctx.projectDir, sessionId: wctx.sessionId };
  const outcome = reviewOutcomeOf(judged);
  writeAcceptedReview(ref, args.state, judged, { by: 'planner', note: args.note });
  const scheduled = judged.scope === 'task' && args.state.phase === 'implementing';
  let state = transitionAndSave(
    ref,
    args.state,
    scheduled
      ? { type: 'CLEAR_SCHEDULED_REVIEW' }
      : {
          type: 'REVIEW_DONE',
          reviewStatus: 'failed',
          ...(args.candidate !== undefined && { candidate: args.candidate }),
        },
  );
  state = transitionAndSave(ref, state, {
    type: 'ACCEPT_AS_IS',
    findings: openFindings(outcome),
    note: args.note,
    by: 'planner',
  });
  args.setTrackedState(state);
  if (!scheduled)
    wctx.bus.publish({
      type: 'workflow_complete',
      ts: Date.now(),
      phase: state.phase,
      review: 'failed',
      blocking: blockingEntries(outcome).length,
      completedTasks: state.tasks.filter((task) => isTaskCompleted(task.status)).length,
    });
  return state;
}

export async function followReviewAnswer(args: {
  wctx: WorkflowContext;
  state: WorkflowState;
  setTrackedState: (s: WorkflowState) => void;
  callbacks: OrchestratorCallbacks;
  candidate: Record<string, string> | undefined;
  fixWork: TriageResult | null;
}): Promise<FollowedReview> {
  const { wctx, setTrackedState, callbacks } = args;
  let state = args.state;
  const judged = state.review;
  const fixWork = args.fixWork;
  if (judged === undefined || fixWork === null) {
    throw error('fix-without-review', 'The run holds no review answer to follow.');
  }
  const entries = blockingEntries(reviewOutcomeOf(judged));
  const blockers = entries.map((entry) => entry.id);
  const blocking = blockers.length;
  const inputs = state.pendingTriage?.inputs ?? [];
  const redInputs = blockingRedInputs(inputs, fixWork);
  if (fixWork.ask !== null) {
    return followReviewQuestion({
      wctx,
      state,
      setTrackedState,
      callbacks,
      candidate: args.candidate,
      ask: fixWork.ask,
      inputs,
      blocking,
      redInputs,
    });
  }
  // A round made no progress when the answer fixes nothing, also when the review failed
  // with no blocker (a criterion no check verified), or when the fix cycle it judges left the same
  // blockers. Only the review that judges the cycle compares, and a round the user steered never
  // does. A cycle whose answer wrote no fix task only re-ran the checks a planner verify named, so
  // no review compares its blockers.
  const idle = fixWork.fixTasks.length === 0;
  const unverified = reviewOutcomeOf(judged).unverifiedCriteria;
  const started =
    judged.judges === undefined
      ? undefined
      : state.triage?.findLast((record) => record.cycle === judged.judges);
  const briefed = fixCyclesOf(state).briefed;
  const before =
    started !== undefined && started.result.fixTasks.length > 0 ? started.blocking : undefined;
  const stuck =
    idle ||
    (blocking > 0 &&
      before !== undefined &&
      !inputs.some((input) => input.source === 'user') &&
      sameFailure(
        [{ source: 'review', keys: before }],
        [{ source: 'review', keys: blockingKeys(reviewOutcomeOf(judged), inputs) }],
      ));
  let next = fixWork;
  if (stuck) {
    // Every round without progress goes to the planner, which sees its earlier answers and
    // decides again; its cannot, its ask-user in a run that cannot ask, or a seat that is down
    // stops the run.
    const target = stuckTarget(state, started?.cycle);
    if (target === undefined) {
      throw error('stuck-review-target', 'The run holds no brief to ask the planner on.');
    }
    const asked = await askPlannerOnStuckReview({
      wctx,
      state,
      setTrackedState,
      cycle: started?.cycle,
      target,
      review: judged,
      fixWork,
      inputs,
      blockers: entries,
      unverified,
    });
    state = asked.state;
    switch (asked.kind) {
      case 'stopped':
      case 'halted':
        return { state, next: 'stop' };
      case 'cannot':
        state = await haltFailedReview({
          wctx,
          state,
          setTrackedState,
          candidate: args.candidate,
          blocking,
          redInputs,
          cannot: asked.reason,
          ...(blocking > 0
            ? {
                noProgress: [
                  ...new Set(
                    blockers.map(
                      (id) =>
                        redChecksOf(redInputs.filter((input) => input.id === id))[0]?.id ?? id,
                    ),
                  ),
                ],
                fixCycle: started === undefined || briefed === 0 ? undefined : briefed,
              }
            : unverified.length > 0 && {
                unverified: unverified.length,
                reviewSeatNoImages: unverified.every(
                  (id) => judged.unseenRenderCriteria?.includes(id) === true,
                ),
                details: [`Unverified criteria: ${unverified.join(', ')}`],
              }),
        });
        return { state, next: 'stop' };
      case 'accept':
        state = acceptStuckReview({
          wctx,
          state,
          setTrackedState,
          candidate: args.candidate,
          judged,
          note: asked.note,
        });
        return { state, next: 'accepted' };
      case 'fix-work':
        if (asked.fixWork.ask !== null)
          return followReviewAnswer({ ...args, state, fixWork: asked.fixWork });
        next = asked.fixWork;
    }
  }
  const applied = applyTriage(
    wctx,
    state,
    judged,
    inputs,
    next,
    undefined,
    judged.scope === 'task' ? judged.afterTaskId : undefined,
  );
  state = startFixCycle({
    wctx,
    state: applied.state,
    setTrackedState,
    taskIds: applied.tasks.map((task) => task.id),
  });
  return { state, next: 'fix' };
}
