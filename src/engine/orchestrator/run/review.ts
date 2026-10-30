import { isTaskCompleted, type TaskId } from '../../../core/schemas/task.js';
import {
  blockingEntries,
  blockingKeys,
  blockingRedInputs,
  openFindings,
  reviewOutcomeOf,
  reviewsAgain,
  setAsideInputs,
} from '../../../core/review/verdict.js';
import { renderReviewMarkdown } from '../../../core/review/render.js';
import { writeSpecFile } from '../../../core/paths-io.js';
import { resolveReviewerRunner } from '../../../core/config/accessors/reviewer-runner.js';
import { getRunnerCatalogDisplayName } from '../../../core/config/accessors/runner-config.js';
import { REVIEW_FILE } from '../../../core/paths.js';
import { nowIso } from '../../../utils/format-time.js';
import { error } from '../../../utils/error.js';
import { publishError } from '../events.js';
import { recordUserMessage } from '../transcript/user-message.js';
import { consultReplyAnswer } from '../consult/apply.js';
import {
  REVIEW_UNAVAILABLE,
  runFinalReviewPhase,
  type FinalReviewFailure,
  type FinalReviewResult,
} from '../final-review.js';
import { reviewName } from '../../../core/recovery/headline.js';
import { buildReviewFailedRecoveryIssue } from '../recovery/builders/task.js';
import { buildReviewInputTooLargeRecoveryIssue } from '../recovery/builders/review-input.js';
import { reviewSeatDetails } from '../recovery/builders/details.js';
import { plannerCallHaltIssue, plannerHaltRow } from '../recovery/planner-call-failure.js';
import { haltSeatProtocolError } from '../recovery/seat-protocol-halt.js';
import { loadSeatSwapContext } from '../recovery/seat-swap-context.js';
import { applyTriage, startFixCycle } from '../triage.js';
import { askPlannerOnStuckReview } from './stuck-review.js';
import { stuckTarget } from '../../../core/review/stuck.js';
import { sameFailure } from '../../../core/state/progress.js';
import { runPreReview } from './pre-review-checks.js';
import {
  raisePendingRecovery,
  rebaseOnPersistedWorkflowState,
  transitionAndSave,
} from '../state-ops.js';
import { waitForPlannerReply } from '../planning/call-loop.js';
import type { TriageInput, TriageResult } from '../../../core/schemas/review.js';
import type { ReviewOutcome } from '../../../core/review/verdict.js';
import type { ReviewRecord, WorkflowState } from '../../../core/schemas/workflow.js';
import type { OrchestratorCallbacks, WorkflowContext } from '../types.js';

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

async function haltFailedReview(args: {
  wctx: WorkflowContext;
  state: WorkflowState;
  setTrackedState: (s: WorkflowState) => void;
  candidate: Record<string, string> | undefined;
  blocking: number;
  redInputs: readonly TriageInput[];
  noProgress?: readonly string[] | undefined;
  fixCycle?: number | undefined;
  unverified?: number | undefined;
  cannot?: string | undefined;
  details?: readonly string[] | undefined;
}): Promise<WorkflowState> {
  const ref = { projectDir: args.wctx.projectDir, sessionId: args.wctx.sessionId };
  const scheduled = args.state.review?.scope === 'task' && args.state.phase === 'implementing';
  const redPending = args.redInputs.length > 0;
  const state = scheduled
    ? queueScheduledTriage(ref, args.state)
    : redPending
      ? args.state
      : transitionAndSave(ref, args.state, {
          type: 'REVIEW_DONE',
          reviewStatus: 'failed',
          ...(args.candidate !== undefined && { candidate: args.candidate }),
        });
  args.setTrackedState(state);
  if (!scheduled && !redPending)
    args.wctx.bus.publish({
      type: 'workflow_complete',
      ts: Date.now(),
      phase: state.phase,
      review: 'failed',
      blocking: args.blocking,
      completedTasks: state.tasks.filter((task) => isTaskCompleted(task.status)).length,
    });
  const details = [
    ...(args.details ?? []),
    ...args.redInputs.map((input) => `${input.id}: ${input.text}`),
  ];
  const issue = buildReviewFailedRecoveryIssue({
    phase: state.phase,
    createdAt: nowIso(),
    blocking: args.blocking,
    ...(args.noProgress !== undefined && { noProgress: args.noProgress }),
    ...(args.fixCycle !== undefined && { fixCycle: args.fixCycle }),
    ...(args.unverified !== undefined && { unverified: args.unverified }),
    ...(args.cannot !== undefined && { cannot: args.cannot }),
    details,
    acceptAsIs: !scheduled && !redPending,
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
    const { runner } = resolveReviewerRunner(wctx.config);
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
      }),
      createdAt: nowIso(),
    });
    return raisePendingRecovery(ref, state, issue, setTrackedState);
  }
  if (failure?.kind === 'seat-protocol-error')
    return haltSeatProtocolError({ wctx, state, setTrackedState, error: failure.error });
  if (failure?.kind === 'seat-blocked') {
    const reviewer = resolveReviewerRunner(wctx.config);
    const followsPlan = reviewer.source === 'planner';
    const issue = await plannerCallHaltIssue({
      projectDir: wctx.projectDir,
      modelCache: wctx.modelCache,
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
    fixWork.verify.length === 0 &&
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
 * The planner's Accept as is of a stuck review, as yours at a halt: the blockers stay open with
 * the planner's note, a final review closes as failed and a scheduled review clears, so the next
 * brief starts. `review.md` names the note.
 */
function acceptStuckReview(args: {
  wctx: WorkflowContext;
  state: WorkflowState;
  setTrackedState: (s: WorkflowState) => void;
  candidate: Record<string, string> | undefined;
  judged: ReviewRecord;
  fixWork: TriageResult;
  inputs: readonly TriageInput[];
  note: string;
}): WorkflowState {
  const { wctx, judged } = args;
  const ref = { projectDir: wctx.projectDir, sessionId: wctx.sessionId };
  const outcome = reviewOutcomeOf(judged);
  writeSpecFile(
    ref,
    REVIEW_FILE,
    renderReviewMarkdown(
      judged.verdict,
      outcome,
      judged.preExistingChecks ?? [],
      setAsideInputs(args.inputs, args.fixWork),
      args.note,
    ),
    wctx.metadata,
  );
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
    state = transitionAndSave(wctx, state, {
      type: 'QUEUE_TRIAGE',
      inputs: [...inputs],
      question: fixWork.ask,
    });
    setTrackedState(state);
    const question = fixWork.ask.question;
    const reply = await waitForPlannerReply(
      { callbacks, sinks: wctx.sinks, signal: wctx.signal },
      {
        call: 'plan',
        text: question,
        questions: [{ id: 'review-ask', type: 'input', text: question }],
        answers: [],
        answered: false,
      },
    );
    if (reply === undefined) {
      state = await haltFailedReview({
        wctx,
        state,
        setTrackedState,
        candidate: args.candidate,
        blocking,
        redInputs,
        details: ['The review asked a question this run has no way to answer.'],
      });
      return { state, next: 'stop' };
    }
    const answered = consultReplyAnswer({ id: 'review-ask', type: 'input', text: question }, reply);
    state = transitionAndSave(wctx, state, {
      type: 'QUEUE_TRIAGE',
      inputs: [
        ...inputs,
        {
          id: `A${inputs.length + 1}`,
          kind: 'answer',
          source: 'user',
          text: answered.message.text,
          file: null,
        },
      ],
    });
    recordUserMessage({ ...wctx, phase: state.phase }, answered.message, {
      qa: answered.qa,
      answerIndex: (state.userAnswers?.length ?? 0) - 1,
    });
    state = rebaseOnPersistedWorkflowState(wctx, state);
    setTrackedState(state);
    return { state, next: 'review' };
  }
  // A round made no progress when the answer fixes and re-runs nothing, also when the review failed
  // with no blocker (a criterion no check verified), or when the fix cycle it judges left the same
  // blockers. Only the review that judges the cycle compares, and a round the user steered never
  // does. A cycle that ran no fix task only re-ran checks, so it moved nothing only when this answer
  // again asks for no fix task.
  const idle = fixWork.fixTasks.length === 0 && fixWork.verify.length === 0;
  const unverified = reviewOutcomeOf(judged).unverifiedCriteria;
  const started =
    judged.judges === undefined
      ? undefined
      : state.triage?.findLast((record) => record.cycle === judged.judges);
  const before =
    started !== undefined && (started.result.fixTasks.length > 0 || fixWork.fixTasks.length === 0)
      ? started.blocking
      : undefined;
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
            ? { noProgress: blockers, fixCycle: started?.cycle }
            : unverified.length > 0 && {
                unverified: unverified.length,
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
          fixWork,
          inputs,
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

export type ScheduledReviewResult = Readonly<{
  state: WorkflowState;
  status: 'continue' | 'stopped';
}>;

/**
 * Follows the review answer a stopped run left pending: the question it asked the user, or the
 * planner call on a stuck review, which runs again on the reviewer's recorded answer.
 */
export async function followPendingReview(
  args: Omit<Parameters<typeof followReviewAnswer>[0], 'fixWork'>,
): Promise<Awaited<ReturnType<typeof followReviewAnswer>> | undefined> {
  const pending = args.state.pendingTriage;
  if (pending?.question !== undefined) {
    return followReviewAnswer({
      ...args,
      fixWork: { fixTasks: [], rejected: [], verify: [], ask: pending.question },
    });
  }
  if (pending?.plannerConsult !== true) return undefined;
  // An answer that fixes, re-runs, rejects and asks nothing records no triage.
  const reviewAt = args.state.review?.at;
  const fixWork = args.state.triage?.findLast((record) => record.reviewAt === reviewAt)?.result;
  return followReviewAnswer({
    ...args,
    fixWork: fixWork ?? { fixTasks: [], rejected: [], verify: [], ask: null },
  });
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
  const anchor = args.afterTaskId ?? state.pendingScheduledReview?.afterTaskId;
  if (anchor !== undefined) {
    state = transitionAndSave(ref, state, {
      type: 'START_SCHEDULED_REVIEW',
      afterTaskId: anchor,
    });
    setTrackedState(state);
  }
  for (;;) {
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
