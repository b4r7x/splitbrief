import { requireReviewSeat } from '../../../../core/config/accessors/reviewer-runner.js';
import { getRunnerCatalogDisplayName } from '../../../../core/config/accessors/runner-config.js';
import { REVIEW_FILE } from '../../../../core/paths.js';
import { reviewName } from '../../../../core/recovery/causes.js';
import { redChecksOf, redCheckLine } from '../../../../core/review/accepted.js';
import type { TriageInput } from '../../../../core/schemas/review/verdict.js';
import { isTaskCompleted } from '../../../../core/schemas/task.js';
import type { WorkflowState } from '../../../../core/schemas/workflow/state.js';
import { nowIso } from '../../../../utils/format/time.js';
import { publishError } from '../../publish/notice.js';
import { reviewSeatDetails } from '../../recovery/builders/details.js';
import { buildReviewFailedRecoveryIssue } from '../../recovery/builders/review-failed.js';
import { buildReviewInputTooLargeRecoveryIssue } from '../../recovery/builders/review-input.js';
import { plannerCallHaltIssue, plannerHaltRow } from '../../recovery/planner-call-failure.js';
import { haltSeatProtocolError } from '../../recovery/seat/protocol-halt.js';
import { loadSeatSwapContext } from '../../recovery/seat/swap-context.js';
import { raisePendingRecovery } from '../../state-ops/halts.js';
import { transitionAndSave } from '../../state-ops/transition.js';
import type { WorkflowContext } from '../../types.js';
import { type FinalReviewResult, type FinalReviewFailure, REVIEW_UNAVAILABLE } from '../types.js';

function noVerdictFailure(review: FinalReviewResult, name: string): FinalReviewFailure | undefined {
  if (review.failure !== undefined) return review.failure;
  if (review.reviewStatus === 'written') return undefined;
  return {
    kind: 'call-failed',
    code: REVIEW_UNAVAILABLE,
    message: `${name} reached no verdict, so nothing was judged.`,
  };
}

/**
 * A scheduled task review parks its pending inputs so the next brief does not
 * start until the halt is answered; a final review and a non-task run have no
 * such marker. The phase is the discriminator: only the task cadence reviews
 * from `implementing`.
 */
function scheduledTaskReview(state: WorkflowState): boolean {
  return state.phase === 'implementing';
}

function queueScheduledTriage(
  ref: { projectDir: string; sessionId: string },
  state: WorkflowState,
): WorkflowState {
  if (!scheduledTaskReview(state)) return state;
  const reviewAfterTaskId =
    state.pendingScheduledReview?.afterTaskId ?? state.pendingTriage?.reviewAfterTaskId;
  return transitionAndSave(ref, state, {
    type: 'QUEUE_TRIAGE',
    inputs: state.pendingTriage?.inputs ?? [],
    ...(state.pendingTriage?.question !== undefined && { question: state.pendingTriage.question }),
    ...(reviewAfterTaskId !== undefined && { reviewAfterTaskId }),
  });
}

export async function haltFailedReview(args: {
  wctx: WorkflowContext;
  state: WorkflowState;
  setTrackedState: (s: WorkflowState) => void;
  candidate: Record<string, string> | undefined;
  blocking: number;
  redInputs: readonly TriageInput[];
  noProgress?: readonly string[] | undefined;
  fixCycle?: number | undefined;
  unverified?: number | undefined;
  reviewSeatNoImages?: boolean | undefined;
  cannot?: string | undefined;
  question?: string | undefined;
  details?: readonly string[] | undefined;
}): Promise<WorkflowState> {
  const ref = { projectDir: args.wctx.projectDir, sessionId: args.wctx.sessionId };
  const scheduled = args.state.review?.scope === 'task' && args.state.phase === 'implementing';
  const state = scheduled
    ? queueScheduledTriage(ref, args.state)
    : transitionAndSave(ref, args.state, {
        type: 'REVIEW_DONE',
        reviewStatus: 'failed',
        ...(args.candidate !== undefined && { candidate: args.candidate }),
      });
  args.setTrackedState(state);
  if (!scheduled)
    args.wctx.bus.publish({
      type: 'workflow_complete',
      ts: Date.now(),
      phase: state.phase,
      review: 'failed',
      blocking: args.blocking,
      completedTasks: state.tasks.filter((task) => isTaskCompleted(task.status)).length,
    });
  // A red check has one line, in the words of the screens that follow an Accept as is. An Apply
  // conflict is no check: its own text names the file.
  const details = [
    ...(args.details ?? []),
    ...redChecksOf(args.redInputs.filter((input) => input.source === 'check')).map(redCheckLine),
    ...args.redInputs
      .filter((input) => input.source !== 'check')
      .map((input) => `${input.id}: ${input.text}`),
  ];
  const issue = buildReviewFailedRecoveryIssue({
    phase: state.phase,
    createdAt: nowIso(),
    blocking: args.blocking,
    ...(args.noProgress !== undefined && { noProgress: args.noProgress }),
    ...(args.fixCycle !== undefined && { fixCycle: args.fixCycle }),
    ...(args.unverified !== undefined && { unverified: args.unverified }),
    reviewSeatNoImages: args.reviewSeatNoImages,
    ...(args.cannot !== undefined && { cannot: args.cannot }),
    ...(args.question !== undefined && { question: args.question }),
    details,
    acceptAsIs: !scheduled && !args.redInputs.some((input) => input.source === 'apply'),
    scope: scheduled ? 'task' : 'final',
    ...(scheduled && { afterTaskId: args.state.review?.afterTaskId }),
  });
  publishError({
    bus: args.wctx.bus,
    phase: state.phase,
    message: `${issue.message}; see ${REVIEW_FILE}`,
    safety: { category: 'recovery', code: 'review_failed' },
  });
  return raisePendingRecovery({ ...ref, bus: args.wctx.bus }, state, issue, args.setTrackedState);
}

export async function haltVerdictlessReview(args: {
  wctx: WorkflowContext;
  state: WorkflowState;
  setTrackedState: (s: WorkflowState) => void;
  review: FinalReviewResult;
}): Promise<WorkflowState | undefined> {
  const { wctx, setTrackedState } = args;
  const ref = { projectDir: wctx.projectDir, sessionId: wctx.sessionId, bus: wctx.bus };
  const judged = scheduledTaskReview(args.state)
    ? { scope: 'task' as const, afterTaskId: args.state.pendingScheduledReview?.afterTaskId }
    : { scope: 'final' as const };
  const failure = noVerdictFailure(args.review, reviewName(judged));
  const state = failure === undefined ? args.state : queueScheduledTriage(ref, args.state);
  if (failure?.kind === 'input-too-large') {
    const { runner } = requireReviewSeat(wctx.config);
    const issue = buildReviewInputTooLargeRecoveryIssue({
      phase: state.phase,
      failure,
      tool: getRunnerCatalogDisplayName(runner),
      acceptAsIs: scheduledTaskReview(state) || state.phase === 'final-review',
      seatSwap: await loadSeatSwapContext({
        projectDir: wctx.projectDir,
        seat: 'review',
        runner,
        config: wctx.config,
        modelCache: wctx.modelCache,
        signal: wctx.signal,
      }),
      createdAt: nowIso(),
    });
    return raisePendingRecovery(ref, state, issue, setTrackedState);
  }
  if (failure?.kind === 'seat-protocol-error')
    return haltSeatProtocolError({ wctx, state, setTrackedState, error: failure.error });
  if (failure?.kind === 'seat-blocked') {
    const reviewer = requireReviewSeat(wctx.config);
    const followsPlan = reviewer.source === 'planner';
    const issue = await plannerCallHaltIssue({
      projectDir: wctx.projectDir,
      modelCache: wctx.modelCache,
      signal: wctx.signal,
      config: wctx.config,
      diagnosis: failure.diagnosis,
      phase: state.phase,
      seat: 'review',
      seatSwitches: state.seatSwitches,
      swap: { seat: 'review', runner: reviewer.runner },
      details: reviewSeatDetails(followsPlan),
    });
    publishError({
      bus: wctx.bus,
      phase: state.phase,
      message: plannerHaltRow(issue, failure.diagnosis),
      resetAt: failure.diagnosis.resetsAt?.toISOString(),
      safety: { category: 'recovery', code: 'review_failed' },
    });
    return raisePendingRecovery(ref, state, issue, setTrackedState);
  }
  if (failure !== undefined) {
    const issue = buildReviewFailedRecoveryIssue({
      phase: state.phase,
      failure,
      ...judged,
      createdAt: nowIso(),
    });
    return raisePendingRecovery(ref, state, issue, setTrackedState);
  }
  return undefined;
}
