import { countNoun } from '../../../../utils/pluralize.js';
import type { SummaryView } from '../view-model.js';
import type { RunRow } from './types.js';

/** How many review notes the summary quotes, and how many rows each one may take. */
export const SUMMARY_NOTES = 2;
const NOTE_LINES = 2;

/**
 * The notes of the review of record: where each one points, then what it says as prose. The
 * summary quotes the first notes in two rows each; the record keeps every note whole.
 */
export function noteRows(view: SummaryView, options: Readonly<{ quoted: boolean }>): RunRow[] {
  if (view.review.kind !== 'written') return [];
  const notes = options.quoted ? view.digest.notes.slice(0, SUMMARY_NOTES) : view.digest.notes;
  const lines = options.quoted ? { maxLines: NOTE_LINES } : {};
  return notes.flatMap((note): RunRow[] => {
    const lead = `${note.id} `;
    if (note.file === null) {
      return [
        {
          label: '',
          segments: [{ text: `${lead}${note.text}`, tone: 'textDim' }],
          hang: lead.length,
          ...lines,
        },
      ];
    }
    return [
      { label: '', segments: [{ text: `${lead}${note.file}`, tone: 'textDim' }] },
      { label: '', segments: [{ text: note.text, tone: 'textDim' }], hang: 0, ...lines },
    ];
  });
}

/** The reviews that failed before the review of record, as one line of history. */
export function earlierReviewRows(view: SummaryView): RunRow[] {
  const failed = view.failedReviews;
  if (failed.length === 0) return [];
  const blocking = failed.map((review) => review.blocking.length).join(', ');
  const passed =
    view.review.kind === 'written' &&
    (view.review.verdict === 'pass' || view.review.verdict === 'pass_with_notes');
  const cycles = view.digest.fixCycles;
  return [
    {
      label: '',
      segments: [
        {
          text: `${countNoun(failed.length, 'earlier review')} failed (${blocking} blocking)`,
          tone: 'textDim',
        },
        ...(passed && cycles > 0
          ? [{ text: `fixed in ${countNoun(cycles, 'fix cycle')}`, tone: 'textDim' as const }]
          : []),
      ],
    },
  ];
}
