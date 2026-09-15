import type { Phase, RecoveryReason } from '../../../../core/schemas/enums.js';
import type { RecoveryIssue } from '../../../../core/schemas/recovery/schemas.js';
import type { RecoveryBuilderBase } from './issue.js';
import { compactFacts, createRecoveryIssue } from './issue.js';
import { chooseRecommended, orderedActions } from './actions.js';
import { switchSeatOffer, type SeatSwapContext } from './task.js';

/** Why the plan seat could not produce its artifact. */
export type PlannerSeatFailure = 'unauthenticated' | 'usage-limit' | 'call-failed';

const PLANNER_FAILURE_REASONS: Record<PlannerSeatFailure, RecoveryReason> = {
  unauthenticated: 'runner-unauthenticated',
  'usage-limit': 'runner-usage-limit',
  'call-failed': 'planner-call-failed',
};

export interface PlannerCallFailureRecoveryOptions extends RecoveryBuilderBase {
  failure: PlannerSeatFailure;
  phase: Phase;
  message: string;
  details?: string[] | undefined;
  tool?: string | undefined;
  /** ISO instant the tool's own diagnostic named as its quota reset, when it named one. */
  resetAt?: string | undefined;
  seatSwap?: SeatSwapContext | undefined;
}

/**
 * A planner call that failed halts the run instead of ending it: the seat can be
 * re-issued, moved to another detected tool, or the run stopped on it. There is
 * no task to skip and no bigger profile to route to — the plan seat either runs
 * again or it does not run.
 */
export function buildPlannerCallFailedRecoveryIssue(
  opts: PlannerCallFailureRecoveryOptions,
): RecoveryIssue {
  const reason = PLANNER_FAILURE_REASONS[opts.failure];
  const offer = switchSeatOffer(opts.seatSwap);
  const actions = orderedActions([
    'retry-same-worker',
    offer === undefined ? undefined : 'switch-seat',
    'pause-run',
    'end-run',
  ]);

  return createRecoveryIssue({
    id: opts.id,
    seat: 'plan',
    reason,
    phase: opts.phase,
    files: [],
    affectedTaskIds: [],
    message: opts.message,
    details: opts.details ?? [],
    ...(opts.resetAt !== undefined && { resetAt: opts.resetAt }),
    ...(offer !== undefined && { switchSeat: offer }),
    facts: compactFacts({ tool: opts.tool }),
    availableActions: actions,
    recommendedAction: chooseRecommended(
      actions,
      opts.failure === 'usage-limit'
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
