import { recoveryActionLabel } from '../../../../core/recovery/action-label.js';
import {
  reviewName,
  reviewNoProgressCause,
  reviewSeatNoImagesCause,
  reviewUnverifiedCause,
  reviewFailedCause,
  cannotDetail,
} from '../../../../core/recovery/causes.js';
import { REVIEW_SEAT_IMAGE_FIX } from '../../../../core/runners/capabilities.js';
import type { Phase } from '../../../../core/schemas/enums.js';
import type { RecoveryIssue } from '../../../../core/schemas/recovery/schemas.js';
import type { TaskId } from '../../../../core/schemas/task.js';
import type { ReviewRecord } from '../../../../core/schemas/workflow/review-record.js';
import {
  apiContextError,
  missingContextWords,
  apiContextRecoveryFacts,
} from '../../../providers/api/context-diagnostic.js';
import type { FinalReviewFailure } from '../../review/types.js';
import { haltActions, chooseRecommended } from './actions.js';
import { type RecoveryBuilderBase, createRecoveryIssue, compactFacts } from './issue.js';

/** A review that judged nothing on a seat that can still run; a blocked seat halts as its runner. */
type NoVerdictReviewFailure = Exclude<
  FinalReviewFailure,
  { kind: 'seat-blocked' | 'seat-protocol-error' | 'input-too-large' }
>;

export interface ReviewFailedRecoveryOptions extends RecoveryBuilderBase {
  phase?: Phase | undefined;
  /** Blocking findings the review reported. Absent when it reached no verdict at all. */
  blocking?: number | undefined;
  details?: readonly string[] | undefined;
  /** Why the review reached no verdict, when it reached none. */
  failure?: NoVerdictReviewFailure | undefined;
  /** A final review can be accepted with its open findings instead of repaired. */
  acceptAsIs?: boolean | undefined;
  /** The blockers a round moved nothing on: the answer fixed none of them, or a fix cycle left them all. */
  noProgress?: readonly string[] | undefined;
  /** The fix cycle that left the same blockers; absent when the answer fixed none. */
  fixCycle?: number | undefined;
  /** The planner's reason why a stuck review's blockers cannot be fixed. */
  cannot?: string | undefined;
  /** The review's question that nobody answered. */
  question?: string | undefined;
  /** Criteria no check could verify, when the review failed with nothing to fix. */
  unverified?: number | undefined;
  /** Every one of those criteria is a render criterion the review seat could not see. */
  reviewSeatNoImages?: boolean | undefined;
  /** The review that judged: a scheduled task review, or the final review when absent. */
  scope?: ReviewRecord['scope'];
  /** The brief a task review judged. */
  afterTaskId?: TaskId | undefined;
}

/**
 * A review that judged nothing is not a review that failed. It names no blocker
 * count, sits on the review seat rather than the briefs it never read, and is
 * re-issued once that seat has what it was missing — so it offers the retry the
 * verdict path does not. The figures stay in facts: `details[]` renders inline
 * and is truncated, and an estimate is for the details view, not the panel.
 */
function buildNoVerdictReviewIssue(
  opts: ReviewFailedRecoveryOptions,
  failure: NoVerdictReviewFailure,
): RecoveryIssue {
  const actions = haltActions('review-failed', ['retry-same-worker', 'end-run']);
  const diagnostic = failure.kind === 'insufficient-context' ? failure.diagnostic : undefined;
  const missing = diagnostic?.missingSections ?? [];
  return createRecoveryIssue({
    id: opts.id,
    seat: 'review',
    reason: 'review-failed',
    phase: opts.phase ?? 'final-review',
    files: [],
    affectedTaskIds: [],
    // One spelling of the diagnosis: the boundary that raised it words it.
    message:
      failure.kind === 'insufficient-context'
        ? apiContextError(failure.diagnostic).message
        : failure.message,
    details: [
      ...(missing.length > 0 ? [`Missing: ${missingContextWords(missing)}`] : []),
      ...(failure.kind === 'call-failed' ? (failure.details ?? []) : []),
      ...(opts.details ?? []),
      ...(diagnostic === undefined
        ? []
        : [
            `Pick a review seat with a larger context in /crew review, then choose ${recoveryActionLabel('retry-same-worker')}.`,
          ]),
    ],
    facts: compactFacts({
      reviewFailureKind: failure.kind,
      cause: failure.kind === 'call-failed' ? failure.cause : undefined,
      reviewScope: opts.scope,
      afterTaskId: opts.afterTaskId,
      ...(diagnostic === undefined ? {} : apiContextRecoveryFacts(diagnostic)),
    }),
    availableActions: actions,
    recommendedAction: chooseRecommended(actions),
    createdAt: opts.createdAt,
  });
}

/**
 * A review still reports blocking findings and its round moved nothing, or it failed with nothing to fix.
 * The operator can send them back through another cycle with a correction of their own (`revise`).
 * A review that failed only on render criteria its seat could not see sits on the review seat:
 * no fix helps, so it offers the review again on the seat the picker holds (`retry-same-worker`).
 */
export function buildReviewFailedRecoveryIssue(opts: ReviewFailedRecoveryOptions): RecoveryIssue {
  if (opts.failure !== undefined) return buildNoVerdictReviewIssue(opts, opts.failure);
  const blocking = opts.blocking ?? 0;
  const noImages = opts.reviewSeatNoImages === true;
  const actions = haltActions('review-failed', [
    noImages ? 'retry-same-worker' : 'revise',
    opts.acceptAsIs === true ? 'accept-as-is' : undefined,
    opts.cannot !== undefined || opts.question !== undefined ? 'decide-for-me' : undefined,
    'end-run',
  ]);
  const review = reviewName(opts);
  const message =
    opts.noProgress !== undefined
      ? reviewNoProgressCause(review, opts.noProgress, opts.fixCycle)
      : noImages
        ? reviewSeatNoImagesCause(review)
            .map((span) => span.text)
            .join('')
        : opts.unverified !== undefined
          ? reviewUnverifiedCause(review, opts.unverified)
          : reviewFailedCause(review, blocking);
  return createRecoveryIssue({
    id: opts.id,
    seat: noImages ? 'review' : 'build',
    reason: 'review-failed',
    phase: opts.phase ?? 'final-review',
    files: [],
    affectedTaskIds: [],
    message,
    details: [
      ...(opts.cannot === undefined ? [] : [cannotDetail('planner', opts.cannot)]),
      ...(opts.question === undefined
        ? []
        : [
            'The review asked a question this run has no way to answer.',
            `Question: ${opts.question}`,
          ]),
      ...(opts.details ?? []),
      ...(noImages
        ? [`${REVIEW_SEAT_IMAGE_FIX}, then choose ${recoveryActionLabel('retry-same-worker')}.`]
        : []),
    ],
    facts: compactFacts({
      blocking,
      noProgress: opts.noProgress?.join(','),
      fixCycle: opts.fixCycle,
      cannot: opts.cannot,
      cannotBy: opts.cannot === undefined ? undefined : 'planner',
      question: opts.question,
      unverified: opts.unverified,
      reviewSeatNoImages: noImages || undefined,
      reviewScope: opts.scope,
      afterTaskId: opts.afterTaskId,
    }),
    availableActions: actions,
    recommendedAction: chooseRecommended(actions),
    createdAt: opts.createdAt,
  });
}
