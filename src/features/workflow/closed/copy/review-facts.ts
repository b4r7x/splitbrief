import { findingFacts, setAsideLine, setAsideLabel } from '../../../../core/review/verdict.js';
import type { SetAside } from '../../../../core/schemas/review/verdict.js';
import { SOFT_SEP } from '../../../../core/separators.js';
import { stateTone } from '../../../../core/theme/state-tone.js';
import { countNoun } from '../../../../utils/pluralize.js';
import type { ReviewView, SummaryView } from '../view-model.js';
import type { CopySegment, RunRow } from './types.js';

/**
 * The closed run reads the final review's record. A run that reviewed each task can still end before
 * its final review, so the absence names that review; a final review that ran without a verdict says so.
 */
export function unwrittenReviewText(review: Exclude<ReviewView, { kind: 'written' }>): string {
  if (review.kind === 'none') return 'no review';
  return review.kind === 'failed' ? 'final review no verdict' : 'final review not run';
}

/** The summary leaves out the validated briefs: its Build row states them. */
export function reviewSegments(
  review: ReviewView,
  options: Readonly<{ evidence: boolean }> = { evidence: true },
): CopySegment[] {
  if (review.kind !== 'written') return [{ text: unwrittenReviewText(review), tone: 'textDim' }];
  const segments: CopySegment[] = [];
  const verdict = verdictSegment(review.verdict);
  if (verdict !== null) segments.push(verdict);
  segments.push(
    ...findingFacts(review.counts).map((text): CopySegment => ({ text, tone: 'textDim' })),
  );
  if (options.evidence && review.evidence.total > 0) {
    segments.push({
      text: `${review.evidence.validated}/${review.evidence.total} briefs validated`,
      tone: 'textDim',
    });
  }
  if (review.missingArtifacts > 0) {
    segments.push({
      text: countNoun(review.missingArtifacts, 'missing artifact'),
      tone: 'warning',
    });
  }
  return segments;
}

/**
 * The accept as is under the failed review: its red checks first, then the owner's note, wrapped
 * under its text.
 */
export function acceptedRows(accepted: SummaryView['accepted']): RunRow[] {
  if (accepted === null) return [];
  const text = ['Accepted as is', accepted.redChecks, accepted.note]
    .filter((part) => part !== null)
    .join(SOFT_SEP);
  return [{ label: '', segments: [{ text, tone: 'text' }], hang: 0 }];
}

/**
 * Each reviewer check the review saw red at the run base too, under the review: the check and its
 * command, then one indented row per failing test it names, in the words of the transcript's base
 * row. A test gets a row of its own, so a long name is cut in the middle rather than dropped.
 */
export function preExistingRows(review: ReviewView): RunRow[] {
  if (review.kind !== 'written') return [];
  return review.preExisting.flatMap((check): RunRow[] => [
    {
      label: '',
      segments: [
        {
          spans: [
            { text: `${check.id} `, tone: 'text' },
            { text: 'pre-existing', tone: stateTone('attention') },
          ],
        },
        { text: check.command, tone: 'textDim' },
      ],
    },
    ...check.tests.map(
      (test): RunRow => ({ label: '', segments: [{ text: `  ${test}`, tone: 'textDim' }] }),
    ),
  ]);
}

/**
 * Each review that failed before the review of record, under the Review row: the review and how
 * many findings blocked it, then one indented prose row per finding, so a fix cycle keeps its
 * reason whole.
 */
export function failedReviewRows(reviews: SummaryView['failedReviews']): RunRow[] {
  return reviews.flatMap((review): RunRow[] => [
    {
      label: '',
      segments: [
        {
          spans: [
            { text: `${review.label} `, tone: 'text' },
            { text: 'failed', tone: stateTone('failed') },
          ],
        },
        ...(review.blocking.length > 0
          ? [{ text: `${review.blocking.length} blocking`, tone: 'textDim' as const }]
          : []),
      ],
    },
    ...review.blocking.map((entry): RunRow => {
      const lead = `  ${entry.id} `;
      return {
        label: '',
        segments: [{ text: `${lead}${entry.text}`, tone: 'textDim' }],
        hang: lead.length,
      };
    }),
    ...setAsideRows(review.setAside, '  '),
  ]);
}

/**
 * Each red input a review set aside, in the words of the transcript, its reason wrapped as prose.
 * The lead puts a row under the earlier review that set it aside.
 */
export function setAsideRows(setAside: readonly SetAside[], lead: string): RunRow[] {
  return setAside.map(
    (entry): RunRow => ({
      label: '',
      segments: [{ text: `${lead}${setAsideLine(entry)}`, tone: 'textDim' }],
      hang: `${lead}${setAsideLabel(entry.id)}: `.length,
    }),
  );
}

function verdictSegment(verdict: 'pass' | 'pass_with_notes' | 'fail' | null): CopySegment | null {
  if (verdict === 'pass') return { text: 'pass', tone: 'success' };
  if (verdict === 'pass_with_notes') return { text: 'pass with notes', tone: 'success' };
  if (verdict === 'fail') return { text: 'failed', tone: 'error' };
  return null;
}
