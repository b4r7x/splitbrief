import { isTaskCompleted, type TaskId } from '../../../core/schemas/task.js';
import { fixCyclesOf, plannerCallsOf, type WorkflowState } from '../../../core/schemas/workflow.js';
import { reviewOutcomeOf } from '../../../core/review/verdict.js';
import { resolveReviewerRunner } from '../../../core/config/accessors/reviewer-runner.js';
import { getRunnerCatalogDisplayName } from '../../../core/config/accessors/runner-config.js';
import { REVIEW_FILE } from '../../../core/paths.js';
import { nowIso } from '../../../utils/format-time.js';
import { error } from '../../../utils/error.js';
import { publishError } from '../events.js';
import {
  REVIEW_UNAVAILABLE,
  runFinalReviewPhase,
  type FinalReviewFailure,
  type FinalReviewResult,
} from '../final-review.js';
import { buildReviewFailedRecoveryIssue } from '../recovery/builders/task.js';
import { buildReviewInputTooLargeRecoveryIssue } from '../recovery/builders/review-input.js';
import { buildConsultBoundRecoveryIssue } from '../recovery/builders/consult.js';
import { reviewSeatDetails } from '../recovery/builders/details.js';
import { plannerCallHaltIssue } from '../recovery/planner-call-failure.js';
import { buildSeatProtocolErrorRecoveryIssue } from '../recovery/builders/seat-protocol.js';
import { loadSeatSwapContext } from '../recovery/seat-swap-context.js';
import type { SeatProtocolError } from '../../runners/typed-output.js';
import { runTriage, startFixCycle } from '../triage.js';
import { raisePendingRecovery, transitionAndSave } from '../state-ops.js';
import type { OrchestratorCallbacks, WorkflowContext } from '../types.js';

function noVerdictFailure(review: FinalReviewResult): FinalReviewFailure | undefined {
  if (review.failure !== undefined) return review.failure;
  if (review.reviewStatus === 'written') return undefined;
  return {
    kind: 'call-failed',
    code: REVIEW_UNAVAILABLE,
    message: 'The final review reached no verdict, so nothing was judged.',
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

async function haltFailedReview(args: {
  wctx: WorkflowContext;
  state: WorkflowState;
  setTrackedState: (s: WorkflowState) => void;
  candidate: Record<string, string> | undefined;
  blocking: number;
  fixCycles?: number | undefined;
  unverified?: number | undefined;
  detail?: string | undefined;
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
  const issue = buildReviewFailedRecoveryIssue({
    phase: state.phase,
    createdAt: nowIso(),
    blocking: args.blocking,
    ...(args.fixCycles !== undefined && { fixCycles: args.fixCycles }),
    ...(args.unverified !== undefined && { unverified: args.unverified }),
    ...(args.detail !== undefined && { detail: args.detail }),
    acceptAsIs: !scheduled,
  });
  publishError({
    bus: args.wctx.bus,
    phase: state.phase,
    message: `${issue.message}; see ${REVIEW_FILE}`,
    safety: { category: 'recovery', code: 'review_failed' },
  });
  return raisePendingRecovery({ ...ref, bus: args.wctx.bus }, state, issue, args.setTrackedState);
}

function haltPlannerCallsSpent(args: {
  wctx: WorkflowContext;
  state: WorkflowState;
  setTrackedState: (s: WorkflowState) => void;
}): WorkflowState {
  const issue = buildConsultBoundRecoveryIssue({
    reason: 'planner-calls-spent',
    lastDiagnosis: 'The review needs planner triage.',
    plannerCalls: plannerCallsOf(args.state).used,
    plannerCallAllowance: plannerCallsOf(args.state).allowance,
    phase: args.state.phase,
    createdAt: nowIso(),
  });
  publishError({ bus: args.wctx.bus, phase: args.state.phase, message: issue.message });
  return raisePendingRecovery(
    { projectDir: args.wctx.projectDir, sessionId: args.wctx.sessionId, bus: args.wctx.bus },
    args.state,
    issue,
    args.setTrackedState,
  );
}

async function haltProtocolError(args: {
  wctx: WorkflowContext;
  state: WorkflowState;
  setTrackedState: (state: WorkflowState) => void;
  error: SeatProtocolError;
}): Promise<WorkflowState> {
  const role = args.error.data.seat;
  const runner =
    role === 'reviewer' ? resolveReviewerRunner(args.wctx.config).runner : args.wctx.config.planner;
  const seatSwap = await loadSeatSwapContext({
    projectDir: args.wctx.projectDir,
    seat: role === 'reviewer' ? 'review' : 'plan',
    runner,
  });
  const issue = buildSeatProtocolErrorRecoveryIssue({
    error: args.error,
    phase: args.state.phase,
    ...(seatSwap !== undefined && { seatSwap }),
    createdAt: nowIso(),
  });
  return raisePendingRecovery(
    { projectDir: args.wctx.projectDir, sessionId: args.wctx.sessionId, bus: args.wctx.bus },
    args.state,
    issue,
    args.setTrackedState,
  );
}

export async function haltVerdictlessReview(args: {
  wctx: WorkflowContext;
  state: WorkflowState;
  setTrackedState: (s: WorkflowState) => void;
  review: FinalReviewResult;
}): Promise<WorkflowState | undefined> {
  const { wctx, setTrackedState } = args;
  const ref = { projectDir: wctx.projectDir, sessionId: wctx.sessionId, bus: wctx.bus };
  const failure = noVerdictFailure(args.review);
  const state = failure === undefined ? args.state : queueScheduledTriage(ref, args.state);
  if (failure?.kind === 'input-too-large') {
    const issue = buildReviewInputTooLargeRecoveryIssue({
      phase: state.phase,
      failure,
      tool: getRunnerCatalogDisplayName(resolveReviewerRunner(wctx.config).runner),
      acceptAsIs: scheduledTaskReview(state) || state.phase === 'final-review',
      createdAt: nowIso(),
    });
    publishError({
      bus: wctx.bus,
      phase: state.phase,
      message: issue.message,
      safety: { category: 'recovery', code: 'review_input_too_large' },
    });
    return raisePendingRecovery(ref, state, issue, setTrackedState);
  }
  // A seat out of quota or signed out halts the way a planner call does; the review
  // already published the tool's own words, so no second error row. A review that
  // follows the planner runs on the plan seat's tool, so its swap moves the plan seat
  // and the review keeps following it.
  if (failure?.kind === 'seat-protocol-error')
    return haltProtocolError({ wctx, state, setTrackedState, error: failure.error });
  if (failure?.kind === 'seat-blocked') {
    const reviewer = resolveReviewerRunner(wctx.config);
    const followsPlan = reviewer.source === 'planner';
    const issue = await plannerCallHaltIssue({
      projectDir: wctx.projectDir,
      diagnosis: failure.diagnosis,
      phase: state.phase,
      seat: 'review',
      seatSwitches: state.seatSwitches,
      swap: { seat: followsPlan ? 'plan' : 'review', runner: reviewer.runner },
      details: reviewSeatDetails(followsPlan),
    });
    return raisePendingRecovery(ref, state, issue, setTrackedState);
  }
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
    return raisePendingRecovery(ref, state, issue, setTrackedState);
  }
  return undefined;
}

export async function triageFailedReview(args: {
  wctx: WorkflowContext;
  state: WorkflowState;
  setTrackedState: (s: WorkflowState) => void;
  callbacks: OrchestratorCallbacks;
  candidate: Record<string, string> | undefined;
  recheckFailures: readonly string[];
}): Promise<{ state: WorkflowState; stopped: boolean }> {
  const { wctx, setTrackedState, callbacks } = args;
  let state = args.state;
  const judged = state.review;
  if (judged === undefined) {
    throw error('triage-without-review', 'The run holds a pending triage but no review to triage.');
  }
  const findings = reviewOutcomeOf(judged).blocking;
  const inputs = state.pendingTriage?.inputs ?? [];
  const cycles = fixCyclesOf(state);
  const blocking = findings.length + args.recheckFailures.length;

  if (cycles.used >= cycles.allowance) {
    state = await haltFailedReview({
      wctx,
      state,
      setTrackedState,
      candidate: args.candidate,
      blocking,
      fixCycles: cycles.used,
    });
    return { state, stopped: true };
  }
  if (findings.length === 0 && inputs.length === 0) {
    const unverified = reviewOutcomeOf(judged).unverifiedCriteria;
    const detail =
      args.recheckFailures.length > 0
        ? args.recheckFailures.join('\n')
        : unverified.length > 0
          ? `Unverified criteria: ${unverified.join(', ')}`
          : undefined;
    state = await haltFailedReview({
      wctx,
      state,
      setTrackedState,
      candidate: args.candidate,
      blocking,
      ...(unverified.length > 0 && { unverified: unverified.length }),
      ...(detail !== undefined && { detail }),
    });
    return { state, stopped: true };
  }

  const triaged = await runTriage(
    {
      projectDir: wctx.projectDir,
      workspaceDir: wctx.workspaceDir,
      sessionId: wctx.sessionId,
      bus: wctx.bus,
      config: wctx.config,
      planner: wctx.planner,
      callbacks,
      sinks: wctx.sinks,
      state,
      ...(wctx.signal !== undefined && { signal: wctx.signal }),
      onStateChange: (next) => {
        state = next;
        setTrackedState(next);
      },
    },
    { review: judged, inputs },
  );
  if (triaged.kind === 'bound-spent') {
    state = queueScheduledTriage({ projectDir: wctx.projectDir, sessionId: wctx.sessionId }, state);
    state = haltPlannerCallsSpent({ wctx, state, setTrackedState });
    return { state, stopped: true };
  }
  if (triaged.kind === 'error') {
    state = queueScheduledTriage({ projectDir: wctx.projectDir, sessionId: wctx.sessionId }, state);
    state = await haltProtocolError({ wctx, state, setTrackedState, error: triaged.error });
    return { state, stopped: true };
  }
  if (triaged.kind === 'unanswered') {
    state = await haltFailedReview({
      wctx,
      state,
      setTrackedState,
      candidate: args.candidate,
      blocking,
      detail: 'The triage asked a question this run has no way to answer.',
    });
    return { state, stopped: true };
  }

  state = startFixCycle({
    wctx,
    state,
    setTrackedState,
    taskIds: triaged.tasks.map((task) => task.id),
  });
  return { state, stopped: false };
}

export type ScheduledReviewResult = Readonly<{
  state: WorkflowState;
  status: 'continue' | 'stopped';
}>;

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
  const scheduledReview = state.pendingScheduledReview?.afterTaskId;
  const judgedReview = state.review;
  const resumesTriage =
    state.pendingTriage?.reviewAfterTaskId !== undefined &&
    scheduledReview !== undefined &&
    judgedReview !== undefined &&
    judgedReview.scope === 'task' &&
    judgedReview.afterTaskId !== undefined &&
    state.pendingTriage.reviewAfterTaskId === judgedReview.afterTaskId &&
    judgedReview.afterTaskId === scheduledReview;
  if (resumesTriage) {
    const triaged = await triageFailedReview({
      wctx,
      state,
      setTrackedState,
      callbacks,
      candidate: undefined,
      recheckFailures: [],
    });
    if (triaged.stopped) return { state: triaged.state, status: 'stopped' };
    return { state: triaged.state, status: 'continue' };
  }
  const anchor = args.afterTaskId ?? state.pendingScheduledReview?.afterTaskId;
  if (anchor !== undefined) {
    state = transitionAndSave(ref, state, {
      type: 'START_SCHEDULED_REVIEW',
      afterTaskId: anchor,
    });
    setTrackedState(state);
  }
  const review = await runFinalReviewPhase({
    projectDir: wctx.projectDir,
    workspaceDir: wctx.workspaceDir,
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
    ...(wctx.context.skillsContext !== undefined && {
      skillsContext: wctx.context.skillsContext,
    }),
    scope: 'task',
    setTrackedState,
  });
  state = review.state;
  setTrackedState(state);
  if (wctx.signal?.aborted) return { state, status: 'stopped' };

  const halted = await haltVerdictlessReview({ wctx, state, setTrackedState, review });
  if (halted !== undefined) return { state: halted, status: 'stopped' };

  if (review.verdict !== null && review.verdict.outcome.kind !== 'fail') {
    state = transitionAndSave(ref, state, { type: 'CLEAR_SCHEDULED_REVIEW' });
    setTrackedState(state);
    return { state, status: 'continue' };
  }

  const triaged = await triageFailedReview({
    wctx,
    state,
    setTrackedState,
    callbacks,
    candidate: undefined,
    recheckFailures: [],
  });
  if (triaged.stopped) return { state: triaged.state, status: 'stopped' };
  return { state: triaged.state, status: 'continue' };
}
