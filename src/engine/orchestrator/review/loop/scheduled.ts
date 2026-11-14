import { resolveReviewCadence } from '../../../../core/config/runtime/resolve.js';
import { queuedUserMessage } from '../../../../core/queue/state.js';
import { recordedFixWork } from '../../../../core/review/accepted.js';
import { reviewsAgain } from '../../../../core/review/scope.js';
import type { TaskId } from '../../../../core/schemas/task.js';
import type { WorkflowState } from '../../../../core/schemas/workflow/state.js';
import { plainUserMessage } from '../../../../core/types/user-input.js';
import { takeSeatChangeAtBoundary } from '../../run/boundary-park.js';
import { followReviewAnswer, reviewPassed } from './follow.js';
import { haltVerdictlessReview } from './halts.js';
import { transitionsAndSave, transitionAndSave } from '../../state-ops/transition.js';
import type { WorkflowContext, OrchestratorCallbacks } from '../../types.js';
import { runPreReview } from '../checks/gate.js';
import { runFinalReviewPhase } from '../phase.js';

export type ScheduledReviewResult = Readonly<{
  state: WorkflowState;
  status: 'continue' | 'stopped';
}>;

/**
 * Follows the review answer a stopped run left pending, on the reviewer's recorded answer: the
 * question it asked the user is asked again, or the planner call on a stuck review runs again.
 */
export async function followPendingReview(
  args: Omit<Parameters<typeof followReviewAnswer>[0], 'fixWork'>,
): Promise<Awaited<ReturnType<typeof followReviewAnswer>> | undefined> {
  const pending = args.state.pendingTriage;
  const fixWork = recordedFixWork(args.state, args.state.review?.at);
  if (pending?.question !== undefined) {
    return followReviewAnswer({ ...args, fixWork: { ...fixWork, ask: pending.question } });
  }
  if (pending?.plannerConsult !== true) return undefined;
  return followReviewAnswer({ ...args, fixWork });
}

export async function runScheduledReview(args: {
  wctx: WorkflowContext;
  state: WorkflowState;
  setTrackedState: (s: WorkflowState) => void;
  callbacks: OrchestratorCallbacks;
  afterTaskId?: TaskId | undefined;
}): Promise<ScheduledReviewResult> {
  const { wctx, setTrackedState, callbacks } = args;
  const ref = { projectDir: wctx.projectDir, sessionId: wctx.sessionId };
  let state = args.state;
  // A task review that a stop or a halt left due, with REVIEW moved to None since: no seat runs it,
  // so it ends here. BUILD on the next brief reads a note saved for it; after the last brief no step does.
  if (resolveReviewCadence(wctx.config) === 'none') {
    const notes =
      state.tasks[state.currentTaskIndex] === undefined
        ? []
        : (state.pendingTriage?.inputs ?? []).filter((input) => input.source === 'user');
    state = transitionsAndSave(
      ref,
      state,
      [
        ...notes.map((note) => ({
          type: 'ENQUEUE_USER_MSG' as const,
          message: queuedUserMessage(plainUserMessage(note.text), state.phase),
        })),
        { type: 'CLEAR_SCHEDULED_REVIEW' },
      ],
      { retryWhile: (head) => head.pendingScheduledReview !== undefined },
    );
    setTrackedState(state);
    return { state, status: 'continue' };
  }
  const anchor = args.afterTaskId ?? state.pendingScheduledReview?.afterTaskId;
  if (anchor !== undefined) {
    state = transitionAndSave(ref, state, {
      type: 'START_SCHEDULED_REVIEW',
      afterTaskId: anchor,
    });
    setTrackedState(state);
  }
  for (;;) {
    const boundary = await takeSeatChangeAtBoundary({ wctx, state, setTrackedState });
    state = boundary.state;
    if (boundary.stopped) return { state, status: 'stopped' };
    const answered = await followPendingReview({
      wctx,
      state,
      setTrackedState,
      callbacks,
      candidate: undefined,
    });
    if (answered !== undefined) {
      state = answered.state;
      if (answered.next === 'stop') return { state, status: 'stopped' };
      if (answered.next !== 'review') return { state, status: 'continue' };
      continue;
    }
    const reviewAgain = reviewsAgain(state, 'task', anchor);
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
      ...(wctx.context.skillsContext !== undefined && {
        skillsContext: wctx.context.skillsContext,
      }),
      scope: 'task',
      ...(anchor !== undefined && { afterTaskId: anchor }),
      ...(!reviewAgain && {
        preReview: (s: WorkflowState) =>
          runPreReview({ wctx, state: s, setTrackedState, scope: 'task' }),
      }),
      setTrackedState,
    });
    state = review.state;
    setTrackedState(state);
    if (wctx.signal?.aborted || review.preReview === 'stopped') return { state, status: 'stopped' };

    const halted = await haltVerdictlessReview({ wctx, state, setTrackedState, review });
    if (halted !== undefined) return { state: halted, status: 'stopped' };

    if (reviewPassed(review.verdict?.outcome, review.fixWork, state.pendingTriage?.inputs ?? [])) {
      state = transitionAndSave(ref, state, { type: 'CLEAR_SCHEDULED_REVIEW' });
      setTrackedState(state);
      return { state, status: 'continue' };
    }
    const followed = await followReviewAnswer({
      wctx,
      state,
      setTrackedState,
      callbacks,
      candidate: undefined,
      fixWork: review.fixWork,
    });
    state = followed.state;
    if (followed.next === 'stop') return { state, status: 'stopped' };
    if (followed.next !== 'review') return { state, status: 'continue' };
  }
}
