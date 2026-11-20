import { SOFT_SEP } from '../../../../core/separators.js';
import { formatTime } from '../../../../utils/format/time.js';
import { countNoun } from '../../../../utils/pluralize.js';
import { noteRows, earlierReviewRows, SUMMARY_NOTES } from './notes.js';
import { fileRow, filesRows } from './change-facts.js';
import {
  applyUndoRows,
  changedRows,
  scopeCleanSegment,
  scopeSegments,
  qualityRows,
  packetPath,
} from './change-facts.js';
import {
  reviewSegments,
  setAsideRows,
  acceptedRows,
  preExistingRows,
  failedReviewRows,
} from './review-facts.js';
import { briefRowParts } from './stage-facts.js';
import { phaseTimes, sessionSegments } from './stage-facts.js';
import { criteriaSegments, stageRow, planSegments, buildSegments } from './stage-facts.js';
import type { BriefRow, SummaryView } from '../view-model.js';
import type { CopyFact, CopySegment, RecordRow, RunRow, SummaryForm } from './types.js';

export function factSpans(fact: CopyFact): readonly CopySegment[] {
  return 'spans' in fact ? fact.spans : [fact];
}

/**
 * The run in one row per stage: what the plan asked for, what the build did, what the review
 * said and what landed. Every brief, file and earlier finding stays in `recordRows`.
 */
export function runRows(view: SummaryView, form: SummaryForm = 'whole'): RunRow[] {
  const times = phaseTimes(view.phases, view.ran);
  const review = [...reviewSegments(view.review, { evidence: false }), ...criteriaSegments(view)];
  const [first, ...rest] = review;
  // The short form drops the accept row, so the Review row names the accept in its first fact,
  // which a row too narrow for every fact keeps longest.
  const accepted: CopySegment = { text: 'accepted as is', tone: 'text' };
  const reviewFacts: CopyFact[] =
    form !== 'labelled' || view.accepted === null
      ? review
      : first === undefined
        ? [accepted]
        : [
            { spans: [...factSpans(first), { text: SOFT_SEP, tone: 'textDim' }, accepted] },
            ...rest,
          ];
  const rows: RunRow[] = [
    ...stageRow('plan', planSegments(view.digest), times.get('planning')),
    ...stageRow('build', buildSegments(view), times.get('implementing')),
    ...stageRow('review', reviewFacts, times.get('review')),
    ...(view.review.kind === 'written' ? setAsideRows(view.review.setAside, '') : []),
    ...acceptedRows(view.accepted),
    ...preExistingRows(view.review),
    ...noteRows(view, { quoted: true }),
    ...earlierReviewRows(view),
    ...applyUndoRows(view.applyUndo),
    ...changedRows(
      view,
      view.digest.leadFiles.map((path) => fileRow(view, path)),
    ),
  ];
  if (view.files.patch !== null) {
    rows.push({ label: 'Patch', segments: [{ text: view.files.patch, tone: 'textDim' }] });
  }
  if (view.scope.kind === 'checked' && scopeCleanSegment(view.scope) === null) {
    rows.push({ label: 'Scope', segments: scopeSegments(view.scope) });
  }
  rows.push(...qualityRows(view.quality));
  rows.push({ label: 'Session', segments: sessionSegments(view.run) });
  return form === 'whole' ? rows : rows.filter((row) => row.label !== '');
}

/**
 * What the record adds to the summary, counted by kind, the most telling kind first: the words of
 * the fold. The labelled summary quotes no note and lists no file, so the record adds them all.
 */
export function recordFold(view: SummaryView, form: SummaryForm): string[] {
  const notes = view.review.kind === 'written' ? view.digest.notes.length : 0;
  const kinds: readonly (readonly [number, string])[] = [
    [view.briefs.rows.length + view.briefs.earlierRows.length, 'brief'],
    [
      (view.files.changed?.length ?? 0) - (form === 'whole' ? view.digest.leadFiles.length : 0),
      'file',
    ],
    [notes - (form === 'whole' ? Math.min(notes, SUMMARY_NOTES) : 0), 'note'],
    [view.failedReviews.length, 'review'],
  ];
  const [first, ...rest] = kinds
    .filter(([count]) => count > 0)
    .map(([count, noun]) => countNoun(count, noun));
  return first === undefined ? ['more'] : [`+${first}`, ...rest];
}

/**
 * The whole record of the run, in the order of the summary: every brief under the build, every
 * note and every failed review under the review, every changed file, then the packet, the scope
 * and the time.
 */
export function recordRows(view: SummaryView): RecordRow[] {
  const times = phaseTimes(view.phases, view.ran);
  const briefs = (rows: readonly BriefRow[]): RecordRow[] =>
    rows.map((row) => ({ brief: briefRowParts({ row }) }));
  const rows: RecordRow[] = [
    ...stageRow('plan', planSegments(view.digest), times.get('planning')),
    ...stageRow('build', buildSegments(view), times.get('implementing')),
    ...briefs(view.briefs.rows),
    ...(view.briefs.earlierRows.length === 0
      ? []
      : [
          { label: '', segments: [{ text: 'Earlier work', tone: 'text' as const }] },
          ...briefs(view.briefs.earlierRows),
        ]),
    ...stageRow(
      'review',
      [...reviewSegments(view.review), ...criteriaSegments(view)],
      times.get('review'),
    ),
    ...(view.review.kind === 'written' ? setAsideRows(view.review.setAside, '') : []),
    ...acceptedRows(view.accepted),
    ...preExistingRows(view.review),
    ...noteRows(view, { quoted: false }),
    ...failedReviewRows(view.failedReviews),
    ...applyUndoRows(view.applyUndo),
    ...changedRows(view, filesRows(view)),
  ];
  const packet = packetPath(view);
  if (packet !== null)
    rows.push({ label: 'Packet', segments: [{ text: packet, tone: 'textDim' }] });
  if (view.files.patch !== null) {
    rows.push({ label: 'Patch', segments: [{ text: view.files.patch, tone: 'textDim' }] });
  }
  rows.push({ label: 'Scope', segments: scopeSegments(view.scope) });
  rows.push(...qualityRows(view.quality));
  rows.push({
    label: 'Ran',
    segments: [
      { text: view.ran === null ? 'not recorded' : formatTime(view.ran), tone: 'textDim' },
    ],
  });
  rows.push({ label: 'Session', segments: sessionSegments(view.run) });
  return rows;
}
