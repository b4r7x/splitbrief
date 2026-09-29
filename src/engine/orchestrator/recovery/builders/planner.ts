import type { Phase, RecoveryReason } from '../../../../core/schemas/enums.js';
import type { RecoveryFact, RecoveryIssue } from '../../../../core/schemas/recovery/schemas.js';
import type { Task } from '../../../../core/schemas/task.js';
import type { PlannerCallDiagnosis } from '../planner-call-failure.js';
import type { RecoveryBuilderBase } from './issue.js';
import { compactFacts, createRecoveryIssue } from './issue.js';
import { availableActionsForReason, chooseRecommended, orderedActions } from './actions.js';
import { taskFiles } from './details.js';
import { switchSeatOffer, type SeatSwapContext } from './task.js';

/** Why the plan seat could not produce its artifact. */
export type PlannerSeatFailure = 'unauthenticated' | 'usage-limit' | 'call-failed';

const PLANNER_FAILURE_REASONS: Record<PlannerSeatFailure, RecoveryReason> = {
  unauthenticated: 'runner-unauthenticated',
  'usage-limit': 'runner-usage-limit',
  'call-failed': 'planner-call-failed',
};

export interface PlannerCallFailureRecoveryOptions extends RecoveryBuilderBase {
  /**
   * What the failed call says about its seat, as `diagnosePlannerCallFailure` reads it. A failure
   * that is read off typed data instead names only its kind and message.
   */
  diagnosis: Pick<PlannerCallDiagnosis, 'failure' | 'message'> & Partial<PlannerCallDiagnosis>;
  phase: Phase;
  /** The planner-tier seat the call ran on. The final review's call halts on the review seat. */
  seat?: 'plan' | 'review' | undefined;
  /** The brief whose hint call it was, when it was one: the halt names it and can skip it. */
  task?: Task | undefined;
  /** What the halt adds after the tool's own words. */
  details?: string[] | undefined;
  seatSwap?: SeatSwapContext | undefined;
  /**
   * Scalar diagnosis the halt carries beyond its prose — the insufficient-context
   * figures, which belong in facts because `details[]` renders inline and is
   * truncated. Merged over the builder's own facts, never replacing them.
   */
  facts?: Record<string, RecoveryFact> | undefined;
}

/**
 * A planner call that failed halts the run instead of ending it: the seat can be
 * re-issued, moved to another detected tool, or the run stopped on it. There is
 * no bigger profile to route to — the seat either runs again or it does not run —
 * and a task to skip only when the call was a brief's hint.
 */
export function buildPlannerCallFailedRecoveryIssue(
  opts: PlannerCallFailureRecoveryOptions,
): RecoveryIssue {
  const { diagnosis } = opts;
  const reason = PLANNER_FAILURE_REASONS[diagnosis.failure];
  const resetsAt = diagnosis.resetsAt ?? null;
  const offer = switchSeatOffer(opts.seatSwap);
  const actions = availableActionsForReason(reason, {
    switchSeat: offer !== undefined,
    routeBigger: false,
  }).filter((action) => action !== 'skip-current-task' || opts.task !== undefined);

  return createRecoveryIssue({
    id: opts.id,
    seat: opts.seat ?? 'plan',
    reason,
    phase: opts.phase,
    task: opts.task,
    files: opts.task === undefined ? [] : taskFiles(opts.task),
    affectedTaskIds: opts.task === undefined ? [] : [opts.task.id],
    message: diagnosis.message,
    details: [...(diagnosis.details ?? []), ...(opts.details ?? [])],
    ...(resetsAt !== null && { resetAt: resetsAt.toISOString() }),
    ...(offer !== undefined && { switchSeat: offer }),
    facts: compactFacts({ tool: diagnosis.tool, ...opts.facts }),
    availableActions: actions,
    recommendedAction: chooseRecommended(
      actions,
      diagnosis.failure === 'usage-limit'
        ? ['switch-seat', 'pause-run']
        : ['retry-same-worker', 'pause-run'],
    ),
    createdAt: opts.createdAt,
  });
}

export interface PlannerArtifactRecoveryOptions extends RecoveryBuilderBase {
  phase: Phase;
  message: string;
  details?: string[] | undefined;
}

/**
 * The planner answered but produced nothing to build. Re-issuing the call or
 * sending it a correction are the two ways forward; neither ends the run.
 */
export function buildPlannerNoBriefsRecoveryIssue(
  opts: PlannerArtifactRecoveryOptions,
): RecoveryIssue {
  const actions = orderedActions(['retry-same-worker', 'revise', 'end-run']);
  return createRecoveryIssue({
    id: opts.id,
    seat: 'plan',
    reason: 'planner-returned-no-briefs',
    phase: opts.phase,
    files: [],
    affectedTaskIds: [],
    message: opts.message,
    details: opts.details ?? [],
    availableActions: actions,
    recommendedAction: chooseRecommended(actions, ['retry-same-worker']),
    createdAt: opts.createdAt,
  });
}

/**
 * The repair loop could not bring the briefs up to the quality bar and no briefs
 * gate is configured, so there is no review to hand them to.
 */
export function buildBriefQualityUnrepairedRecoveryIssue(
  opts: PlannerArtifactRecoveryOptions,
): RecoveryIssue {
  const actions = orderedActions(['retry-same-worker', 'revise', 'end-run']);
  return createRecoveryIssue({
    id: opts.id,
    seat: 'plan',
    reason: 'brief-quality-unrepaired',
    phase: opts.phase,
    files: [],
    affectedTaskIds: [],
    message: opts.message,
    details: opts.details ?? [],
    availableActions: actions,
    recommendedAction: chooseRecommended(actions, ['revise']),
    createdAt: opts.createdAt,
  });
}

/**
 * The briefs gate has gone round the same failure enough times that another turn
 * of it is not review. The run stops for a decision; it never ends itself.
 */
export function buildBriefReviewNoProgressRecoveryIssue(
  opts: PlannerArtifactRecoveryOptions,
): RecoveryIssue {
  const actions = orderedActions(['revise', 'end-run']);
  return createRecoveryIssue({
    id: opts.id,
    reason: 'brief-review-no-progress',
    phase: opts.phase,
    files: [],
    affectedTaskIds: [],
    message: opts.message,
    details: opts.details ?? [],
    availableActions: actions,
    recommendedAction: 'revise',
    createdAt: opts.createdAt,
  });
}

/** A hard constitution violation: the spec is rewritten, or the run stops. */
export function buildConstitutionCheckFailedRecoveryIssue(
  opts: PlannerArtifactRecoveryOptions,
): RecoveryIssue {
  const actions = orderedActions(['revise-spec', 'end-run']);
  return createRecoveryIssue({
    id: opts.id,
    seat: 'plan',
    reason: 'constitution-check-failed',
    phase: opts.phase,
    files: [],
    affectedTaskIds: [],
    message: opts.message,
    details: opts.details ?? [],
    availableActions: actions,
    recommendedAction: 'revise-spec',
    createdAt: opts.createdAt,
  });
}
