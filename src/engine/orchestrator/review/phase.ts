import { requireReviewSeat } from '../../../core/config/accessors/reviewer-runner.js';
import {
  getRunnerModelName,
  getRunnerDisplayName,
} from '../../../core/config/accessors/runner-config.js';
import { renderReviewMarkdown } from '../../../core/review/render.js';
import { blockingRedInputs, deriveReviewOutcome } from '../../../core/review/verdict.js';
import { seatAxisWords } from '../../../core/runners/effort-channel.js';
import type { Config } from '../../../core/schemas/config.js';
import type {
  TriageResult,
  SetAside,
  ReviewVerdict,
} from '../../../core/schemas/review/verdict.js';
import type { TaskId } from '../../../core/schemas/task.js';
import { type WorkflowState, fixCyclesOf } from '../../../core/schemas/workflow/state.js';
import { sessionError } from '../../../core/sessions/errors.js';
import type { SpecMetadata } from '../../../core/sessions/spec-files.js';
import { isAbortError } from '../../../utils/abort.js';
import type { SteeringPort } from '../../calls/steering.js';
import type { EventBus } from '../../events/types.js';
import type { ModelCacheAccessor } from '../../providers/model/runtime-snapshot.js';
import type { Reviewer } from '../../planners/reviewer.js';
import type { ContinuationHolder } from '../continuation/holder.js';
import type { RunReviewScope } from '../evidence/review-packet/run-scope.js';
import { publishReviewEvent } from '../publish/review.js';
import type { PreReviewResult } from './checks/gate.js';
import { transitionAndSave } from '../state-ops/transition.js';
import { rebaseOnPersistedWorkflowState } from '../state-ops/head.js';
import type { SummaryBase } from '../summary/build.js';
import type { OrchestratorCallbacks, WorkflowSinks } from '../types.js';
import type { BaseGate } from '../validation/base-gate.js';
import { callReviewer } from './call.js';
import { publishReviewFailure } from './failure.js';
import { resolveReviewBounds, collectReviewInputs } from './inputs.js';
import { prepareReviewCall } from './prompt.js';
import { recordReview, writeReviewFiles, finishReview } from './record.js';
import type {
  FinalReviewResult,
  FinalReview,
  ReviewPhaseStatus,
  ReviewStatePort,
  SentReviewPrompt,
} from './types.js';
import { reviewVerdictSchema } from './verdict-schema.js';
import { verifyReviewClaims, keepUnseenRendersUnverified } from './verify-claims.js';

type FinalReviewPhaseOptions = {
  projectDir: string;
  workspaceDir: string;
  sessionId: string;
  config: Config;
  callbacks: OrchestratorCallbacks;
  bus: EventBus;
  state: WorkflowState;
  reviewer: Reviewer;
  steering?: SteeringPort | undefined;
  metadata?: SpecMetadata | null;
  modelCache: ModelCacheAccessor | undefined;
  signal?: AbortSignal | undefined;
  sinks?: WorkflowSinks | undefined;
  continuation?: ContinuationHolder | undefined;
  summaryBase?: SummaryBase | undefined;
  setTrackedState?: ((state: WorkflowState) => void) | undefined;
  skillsContext?: string | undefined;
  /** The integration re-check section when an Apply merge changed the reviewed candidate. */
  integration?: string | undefined;
  /** The cadence this review serves: 'task' is the scheduled mid-run review, 'final' the run's last. */
  scope?: 'final' | 'task' | undefined;
  afterTaskId?: TaskId | undefined;
  /**
   * The checks run on the candidate before the review call. New
   * failures become pending inputs in the review answer.
   */
  preReview?: ((state: WorkflowState) => Promise<PreReviewResult>) | undefined;
  /**
   * SPLITBRIEF runs the project gate the plan names before the verdict call of the final review,
   * and compares a red command with its run at the run base (`baseGate`). A review that only
   * re-answers a pending question on the same candidate skips it.
   */
  reviewChecks?: { baseGate: BaseGate | undefined } | undefined;
};

/**
 * The start of the phase: the state rebased on the saved one, ALL_DONE on a fresh final review,
 * and the pre-review checks, whose halt ends the phase before the review starts.
 */
async function openReview(
  opts: FinalReviewPhaseOptions,
): Promise<
  | Readonly<{ kind: 'review'; state: WorkflowState; reviewedBeforeStart: ReadonlySet<string> }>
  | Readonly<{ kind: 'stopped'; state: WorkflowState }>
> {
  const { projectDir, sessionId } = opts;
  let state = rebaseOnPersistedWorkflowState({ projectDir, sessionId }, opts.state, {
    keepUnsaved: true,
  });
  const reviewedBeforeStart = new Set(
    state.messageQueue
      .filter((message) => message.deliveredTo?.reviewer !== undefined)
      .map((message) => message.id),
  );

  // On resume the state is already persisted in 'final-review' (a previously failed
  // gate); only dispatch ALL_DONE from 'implementing' on a fresh forward run. A
  // task-cadence review runs mid-run and leaves the phase where it found it.
  if (state.phase === 'implementing' && opts.scope !== 'task') {
    state = transitionAndSave({ projectDir, sessionId }, state, { type: 'ALL_DONE' });
    // The call publisher stamps runner events with the tracked phase; the
    // reviewer's own call must read as final-review, not the last brief's.
    opts.setTrackedState?.(state);
  }

  // A check that cannot run halts before the review.
  if (opts.preReview !== undefined) {
    const pre = await opts.preReview(state);
    state = pre.state;
    opts.setTrackedState?.(state);
    if (pre.kind !== 'review') return { kind: pre.kind, state };
  }
  return { kind: 'review', state, reviewedBeforeStart };
}

export async function runFinalReviewPhase(
  opts: FinalReviewPhaseOptions,
): Promise<FinalReviewResult> {
  const {
    projectDir,
    workspaceDir,
    sessionId,
    config,
    callbacks,
    bus,
    reviewer,
    metadata,
    summaryBase,
  } = opts;
  const opened = await openReview(opts);
  let { state } = opened;
  if (opened.kind !== 'review') {
    return {
      state,
      summaryBase,
      verdict: null,
      fixWork: null,
      reviewText: '',
      reviewStatus: 'failed',
      preReview: opened.kind,
    };
  }
  const { reviewedBeforeStart } = opened;
  const live: ReviewStatePort = {
    get: () => state,
    set: (next) => {
      state = next;
    },
  };

  const reviewRunner = requireReviewSeat(config).runner;
  const reviewModel = getRunnerModelName(reviewRunner);
  const reviewAxes = seatAxisWords(reviewRunner);
  const cadence = opts.scope ?? 'final';
  const reviewEvent = {
    scope: cadence,
    ...(cadence === 'task' && opts.afterTaskId !== undefined && { afterTaskId: opts.afterTaskId }),
    tool: getRunnerDisplayName(reviewRunner),
    ...(reviewModel !== undefined && { model: reviewModel }),
    ...(reviewAxes.length > 0 && { axes: [...reviewAxes] }),
  };

  const finalReviewStart = Date.now();
  const interrupted = (): FinalReviewResult => {
    publishReviewEvent(
      { bus, phase: state.phase },
      {
        type: 'review_completed',
        ...reviewEvent,
        verdict: 'stopped',
        duration: Date.now() - finalReviewStart,
      },
    );
    return {
      state,
      summaryBase,
      verdict: null,
      fixWork: null,
      reviewText: '',
      reviewStatus: 'failed',
    };
  };
  publishReviewEvent({ bus, phase: state.phase }, { type: 'review_started', ...reviewEvent });
  bus.publish({ type: 'review_step', ts: Date.now(), phase: state.phase, step: 'verdict' });
  if (opts.signal?.aborted) return interrupted();
  if (opts.scope !== 'task') {
    bus.publish({ type: 'all_tasks_done', ts: Date.now(), phase: state.phase });
  }

  let writeStatus: 'written' | 'failed' = 'written';
  let reviewText = '';
  let verdict: FinalReview | null = null;
  let fixWork: TriageResult | null = null;
  let setAside: SetAside[] = [];
  let reviewScope: RunReviewScope | undefined;
  let failure: FinalReviewResult['failure'];
  const sent: SentReviewPrompt = {
    text: '',
    suffix: '',
    reviewInput: undefined,
    tooLarge: undefined,
  };
  try {
    const bounds = await resolveReviewBounds({
      projectDir,
      workspaceDir,
      sessionId,
      state,
      cadence,
    });
    reviewScope = bounds.reviewScope;
    const ctx = {
      projectDir,
      workspaceDir,
      sessionId,
      bus,
      signal: opts.signal,
      live,
      setTrackedState: opts.setTrackedState,
    };
    const inputs = await collectReviewInputs({
      ...ctx,
      config,
      bounds,
      runner: reviewRunner,
      modelCache: opts.modelCache,
      reviewChecks: opts.reviewChecks,
    });
    const { preExistingChecks } = inputs;
    const step = { kind: 'review' as const, cycle: fixCyclesOf(state).used };
    // One continuation, one call: a retried review is the whole prompt again
    // with the operator's note on the end, never a session resume.
    const asked = await callReviewer(
      {
        ...ctx,
        reviewer,
        config,
        callbacks,
        sinks: opts.sinks,
        steering: opts.steering,
        schema: reviewVerdictSchema({
          getState: live.get,
          scope: bounds.scope,
          config,
          workspaceDir,
          userFiles: bounds.userFiles,
          testChecks: inputs.testChecks,
        }),
        step,
        prepareCall: (steerImages) =>
          prepareReviewCall(
            {
              ...ctx,
              runner: reviewRunner,
              cadence,
              bounds,
              inputs,
              integration: opts.integration,
              skillsContext: opts.skillsContext,
              reviewedBeforeStart,
              sent,
            },
            steerImages,
          ),
      },
      opts.continuation?.take(step),
    );
    if (asked.kind === 'stopped') return interrupted();
    if (asked.kind === 'refused') {
      failure = { kind: 'seat-protocol-error', error: asked.error };
      throw asked.error;
    }
    const { answer } = asked;
    fixWork = { fixTasks: answer.fixTasks, rejected: answer.rejected, ask: answer.ask };
    const redInputs = blockingRedInputs(state.pendingTriage?.inputs ?? [], fixWork);
    const { tasks, criteria, findings } = answer;
    const reviewerVerdict: ReviewVerdict = { tasks, criteria, findings };
    const verification = await verifyReviewClaims({
      verdict: reviewerVerdict,
      scope: bounds.scope,
      state,
      redInputs,
      preExistingChecks,
      projectDir,
      workspaceDir,
      sessionId,
      config,
      bus,
      ...(opts.signal !== undefined && { signal: opts.signal }),
    });
    const held = keepUnseenRendersUnverified({
      verdict: reviewerVerdict,
      verification,
      missingCheckIds: inputs.renders.missingCheckIds,
      plan: state.plan,
      seatTakesImages: inputs.seatTakesImages,
    });
    const outcome = deriveReviewOutcome(
      held.verdict,
      bounds.scope,
      held.verification.map,
      redInputs,
    );
    const recorded = recordReview({
      projectDir,
      sessionId,
      bus,
      live,
      cadence,
      scope: bounds.scope,
      verdict: held.verdict,
      outcome,
      verification: held.verification.entries,
      fixWork,
      preExistingChecks,
      unseenRenderCriteria: held.unseenRenderCriteria,
    });
    setAside = recorded.setAside;
    verdict = { verdict: held.verdict, outcome };
    reviewText = renderReviewMarkdown(
      held.verdict,
      state.tasks,
      outcome,
      preExistingChecks,
      setAside,
    );
    writeReviewFiles({ projectDir, sessionId }, recorded.record, reviewText, metadata);
  } catch (err) {
    if (opts.signal?.aborted || isAbortError(err)) return interrupted();
    if (sessionError.isLocalSaveFailure(err)) throw err;
    failure = publishReviewFailure({
      err,
      named: failure ?? sent.tooLarge,
      sent,
      config,
      review: reviewEvent,
      sessionId,
      workspaceDir,
      bus,
      phase: state.phase,
    });
    writeStatus = 'failed';
  }
  if (opts.signal?.aborted) return interrupted();

  await finishReview({
    projectDir,
    workspaceDir,
    sessionId,
    bus,
    state,
    event: reviewEvent,
    startedAt: finalReviewStart,
    writeStatus,
    verdict,
    setAside,
    summaryBase,
    reviewScope,
    reviewInput: sent.reviewInput,
  });

  const reviewStatus: ReviewPhaseStatus =
    writeStatus === 'failed' || verdict === null ? 'failed' : 'written';
  return {
    state,
    summaryBase,
    verdict,
    fixWork,
    reviewText,
    reviewStatus,
    ...(failure && { failure }),
  };
}
