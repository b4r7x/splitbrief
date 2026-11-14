import { reviewName, finalReviewAnchor } from '../../../core/recovery/causes.js';
import { namedFailures } from '../../../core/review/base-split.js';
import type { EvidenceLedger, EvidenceReview } from '../../../core/schemas/evidence.js';
import type { SetAside } from '../../../core/schemas/review/verdict.js';
import type { Summary } from '../../../core/schemas/summary.js';
import type { ReviewRecord } from '../../../core/schemas/workflow/review-record.js';
import {
  sanitizeTerminalDisplayText,
  oneLineDisplayText,
} from '../../../utils/display-text/sanitize.js';
import type { ReviewView, FailedReviewView } from './view-model.js';

/**
 * The packet is the review of record; `summary.review` only answers for sessions written before it.
 * `preExistingChecks` are the reviewer checks the review's own record saw red at the run base too.
 */
export function reviewView(
  summary: Summary,
  preExistingChecks: NonNullable<ReviewRecord['preExistingChecks']>,
  ledger: EvidenceLedger | null,
): ReviewView {
  if (summary.reviewerSeat === 'none') return { kind: 'none' };
  const setAside = setAsideView(ledgerReviews(ledger).record);
  const preExisting = preExistingChecks.map((check) => ({
    id: sanitizeTerminalDisplayText(check.id),
    command: sanitizeTerminalDisplayText(check.command),
    tests: namedFailures(check.keys, check.keys.length).map((name) =>
      sanitizeTerminalDisplayText(name),
    ),
  }));
  const packet = summary.reviewPacket;
  if (packet === undefined) {
    const legacy = summary.review;
    if (legacy === undefined) return { kind: 'not-run' };
    return {
      kind: 'written',
      verdict: legacy.verdict,
      counts: { critical: legacy.critical, warning: legacy.warnings, note: legacy.notes },
      markdownPath: '',
      evidence: {
        validated: summary.completedByLocal,
        total: summary.evidenceSummary?.totalTasks ?? summary.totalTasks,
      },
      missingArtifacts: 0,
      preExisting,
      setAside,
    };
  }
  if (packet.finalReviewStatus !== 'written') return { kind: packet.finalReviewStatus };
  return {
    kind: 'written',
    verdict: packet.finalReviewVerdict,
    counts: packet.finalReviewFindingCounts,
    markdownPath: sanitizeTerminalDisplayText(packet.markdownPath),
    evidence: { validated: packet.evidenceValidatedTasks, total: packet.evidenceTotalTasks },
    missingArtifacts: packet.missingArtifactCount,
    preExisting,
    setAside,
  };
}

/** The ledger's reviews split at the review of record: the last review, when it is a final review. */
function ledgerReviews(ledger: EvidenceLedger | null): {
  record: EvidenceReview | null;
  earlier: EvidenceReview[];
} {
  const reviews = ledger?.reviews ?? [];
  const last = reviews.at(-1);
  return last?.scope === 'final'
    ? { record: last, earlier: reviews.slice(0, -1) }
    : { record: null, earlier: reviews };
}

function setAsideView(review: EvidenceReview | null): SetAside[] {
  return (review?.setAside ?? []).map((entry) => ({
    id: oneLineDisplayText(entry.id),
    reason: oneLineDisplayText(entry.reason),
  }));
}

/**
 * The reviews the ledger recorded as failed, except the review of record, which the Review row
 * already states. A final review is named as the transcript names it, by the fix cycles before it
 * and a re-run within one cycle.
 */
export function failedReviewViews(ledger: EvidenceLedger | null): FailedReviewView[] {
  const { earlier } = ledgerReviews(ledger);
  const label = (review: EvidenceReview, index: number): string => {
    if (review.scope !== 'final') return reviewName(review);
    const reruns = earlier
      .slice(0, index)
      .filter((before) => before.scope === 'final' && before.cycle === review.cycle).length;
    const anchor = finalReviewAnchor(review.cycle, reruns);
    return anchor === undefined ? reviewName(review) : `${reviewName(review)} ${anchor}`;
  };
  return earlier.flatMap((review, index) =>
    review.outcome === 'fail'
      ? [
          {
            label: label(review, index),
            blocking: review.blocking.map((entry) => ({
              id: oneLineDisplayText(entry.id),
              text: oneLineDisplayText(entry.text),
            })),
            setAside: setAsideView(review),
          },
        ]
      : [],
  );
}
