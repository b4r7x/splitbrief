import type { TaskSummaryState } from '../../../components/task-summary.js';
import type { TaskCompletionMethod } from '../../../core/schemas/enums.js';
import type {
  BriefRow,
  BriefRowState,
  ReviewView,
  ScopeView,
  SeatView,
  SummaryView,
} from './view-model.js';
import {
  PLANNER_INHERITANCE,
  formatCollapsedSeatSpansFromIdentities,
  type SeatLineSpan,
  type CrewSeatId,
} from '../../../core/crew/identity.js';
import { formatScoreSummaryParts } from '../../../core/formatting.js';
import { SESSIONS_DIR, SPLITBRIEF_DIR } from '../../../core/paths.js';
import { arrowSep } from '../../../core/separators.js';
import { formatTime } from '../../../utils/format-time.js';
import { countNoun } from '../../../utils/pluralize.js';
import { stateTone, type StateTone } from '../../../core/theme/state-tone.js';

/**
 * Theme keys, so a row says which colour it wants and the renderer indexes the theme instead of
 * translating a second vocabulary. `link` is the one that is not a top-level key: it is
 * `theme.markdown.link`, the colour every other file path on the screen already wears.
 */
export type CopyTone = 'text' | 'link' | StateTone | 'planner' | 'implementer' | 'reviewer';

export interface CopySegment {
  text: string;
  tone: CopyTone;
}

export type CopyFact = CopySegment | Readonly<{ spans: readonly CopySegment[] }>;

export function factSpans(fact: CopyFact): readonly CopySegment[] {
  return 'spans' in fact ? fact.spans : [fact];
}

export interface RunRow {
  /** Empty on a follow-on row, which reads as part of the labelled row above it. */
  label: string;
  seat?: CrewSeatId;
  /** Each fact fits as one unit; the renderer joins facts with ` · `. */
  segments: readonly CopyFact[];
}

export interface FileRow {
  path: string;
  partial: boolean;
}

export interface BriefRowParts {
  id: string;
  title: string;
  state: Exclude<TaskSummaryState, { kind: 'stage' }>;
  retries?: number | undefined;
  duration?: number | undefined;
  file?: string | undefined;
  fileNote?: string | undefined;
  extraFiles?: string | undefined;
  note?: string | undefined;
}

/** The two finding tallies every review sentence spells the same way. */
export function findingCounts(counts: Readonly<{ critical: number; warning: number }>): string {
  return `${counts.critical} blocking, ${counts.warning} advisory`;
}

/**
 * What the run did, and never what it cost. The view carries no money and no token counts: the
 * record keeps them for the reader who opens `/usage`.
 */
export function runRows(view: SummaryView): RunRow[] {
  const rows: RunRow[] = [
    { label: 'Review', seat: 'review', segments: reviewSegments(view.review) },
    ...preExistingRows(view.review),
    ...failedReviewRows(view.failedReviews),
  ];
  if (view.applyUndo !== null) {
    const conflicts = view.applyUndo.conflicts.length;
    rows.push({
      label: 'Apply',
      segments: [
        {
          spans: [
            { text: 'undone', tone: stateTone('attention') },
            ...(conflicts === 0
              ? []
              : [{ text: `, ${countNoun(conflicts, 'conflict')} kept`, tone: 'textDim' as const }]),
          ],
        },
      ],
    });
  }
  const packet = packetPath(view);
  if (packet !== null) rows.push({ label: 'Packet', segments: [{ text: packet, tone: 'link' }] });
  if (view.files.patch !== null) {
    rows.push({ label: 'Patch', segments: [{ text: view.files.patch, tone: 'link' }] });
  }
  rows.push({ label: 'Scope', segments: scopeSegments(view.scope) });
  const quality = view.quality;
  if (quality !== null) {
    const spans = formatScoreSummaryParts(quality.score, quality, 'quality').map(
      (part): CopySegment => ({
        text: part.text,
        tone:
          part.kind === 'error'
            ? stateTone('failed')
            : part.kind === 'warning' || (part.kind === 'score' && !quality.passed)
              ? stateTone('attention')
              : 'textDim',
      }),
    );
    rows.push({ label: 'Briefs', segments: [{ spans }] });
  }
  rows.push({
    label: 'Ran',
    segments: [
      { text: view.ran === null ? 'not recorded' : formatTime(view.ran), tone: 'textDim' },
    ],
  });
  const phases = phaseSegments(view.phases);
  if (phases.length > 0) rows.push({ label: 'Phases', segments: phases });
  rows.push({ label: 'Session', segments: sessionSegments(view.run) });
  return rows;
}

/**
 * The closed run reads the final review's record. A run that reviewed each task can still end before
 * its final review, so the absence names that review.
 */
export const FINAL_REVIEW_NOT_RUN = 'final review not run';

function reviewSegments(review: ReviewView): CopySegment[] {
  if (review.kind !== 'written') return [{ text: FINAL_REVIEW_NOT_RUN, tone: 'textDim' }];
  const segments: CopySegment[] = [];
  const verdict = verdictSegment(review.verdict);
  if (verdict !== null) segments.push(verdict);
  segments.push({ text: findingCounts(review.counts), tone: 'textDim' });
  if (review.evidence.total > 0) {
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
 * Each reviewer check the review saw red at the run base too, under the review: the check and its
 * command, then one indented row per failing test it names, in the words of the transcript's base
 * row. A test gets a row of its own, so a long name is cut in the middle rather than dropped.
 */
function preExistingRows(review: ReviewView): RunRow[] {
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
 * many findings blocked it, then one indented row per finding, so a fix cycle keeps its reason.
 */
function failedReviewRows(reviews: SummaryView['failedReviews']): RunRow[] {
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
    ...review.blocking.map(
      (entry): RunRow => ({
        label: '',
        segments: [{ text: `  ${entry.id} ${entry.text}`, tone: 'textDim' }],
      }),
    ),
  ]);
}

function verdictSegment(verdict: 'pass' | 'pass_with_notes' | 'fail' | null): CopySegment | null {
  if (verdict === 'pass') return { text: 'pass', tone: 'success' };
  if (verdict === 'pass_with_notes') return { text: 'pass with notes', tone: 'success' };
  if (verdict === 'fail') return { text: 'failed', tone: 'error' };
  return null;
}

/**
 * The packet is named once, project-relative: the record keeps only the file name, and the session
 * it belongs to is the directory. A record that already carries a path is trusted as it stands.
 */
function packetPath(view: SummaryView): string | null {
  if (view.review.kind !== 'written') return null;
  const stored = view.review.markdownPath;
  if (stored === '') return null;
  if (stored.includes('/')) return stored;
  const sessionId = view.run.sessionId;
  if (sessionId === '') return stored;
  return `${SPLITBRIEF_DIR}/${SESSIONS_DIR}/${sessionId}/${stored}`;
}

export function scopeCleanSegment(scope: ScopeView): CopySegment | null {
  if (scope.kind === 'not-run' || scope.errors + scope.warnings !== 0) return null;
  return { text: 'clean', tone: stateTone('passed') };
}

function scopeSegments(scope: ScopeView): CopySegment[] {
  if (scope.kind === 'not-run') return [{ text: 'not checked', tone: 'textDim' }];
  const clean = scopeCleanSegment(scope);
  if (clean !== null) return [clean];
  return [
    ...(scope.errors > 0
      ? [{ text: countNoun(scope.errors, 'error'), tone: stateTone('failed') }]
      : []),
    ...(scope.warnings > 0
      ? [{ text: countNoun(scope.warnings, 'warning'), tone: stateTone('attention') }]
      : []),
  ];
}

/** One phase would only restate the `Ran` row above it. */
function phaseSegments(phases: SummaryView['phases']): CopySegment[] {
  if (phases.length < 2) return [];
  return phases.map((timing) => ({
    text: `${timing.phase} ${formatTime(timing.ms)}`,
    tone: 'textDim',
  }));
}

function sessionSegments(run: SummaryView['run']): CopySegment[] {
  return [{ text: run.sessionId, tone: 'textDim' }];
}

/**
 * The crew line the header would paint, laid out to whatever the Run block can spare. The summary
 * has names on record rather than runner blocks, so it enters the layout half directly.
 */
export function crewLine(view: SummaryView, budget: number): readonly SeatLineSpan[] {
  return formatCollapsedSeatSpansFromIdentities({
    plan: seatWord(view.seats.plan),
    build: seatWord(view.seats.build),
    review: view.seats.review.kind === 'inherits' ? null : seatWord(view.seats.review),
    budget,
  });
}

function seatWord(seat: SeatView): string {
  switch (seat.kind) {
    case 'named':
      return seat.short;
    case 'mixed':
      return seat.profiles.length === 0
        ? 'mixed workers'
        : `mixed workers (${seat.profiles.join(', ')})`;
    // A seat that left one tool for good reads as the move; one that went back and forth has no
    // single move to name, so it says how much each tool did.
    case 'moved':
      return seat.contiguous
        ? seat.seats.map((moved) => moved.short).join(arrowSep())
        : seat.seats
            .map((moved, index) =>
              index === 0
                ? `${countNoun(moved.briefs, 'brief')} on ${moved.short}`
                : `${moved.briefs} on ${moved.short}`,
            )
            .join(', ');
    case 'inherits':
      return PLANNER_INHERITANCE.mark;
    default:
      return 'not recorded';
  }
}

type SettledBriefState = Exclude<BriefRowState, 'stopped' | 'pending'>;

/** The method a ledger-only brief implies, for rows the spend record never booked. */
const SETTLED_METHODS: Readonly<Record<SettledBriefState, TaskCompletionMethod>> = {
  local: 'local',
  escalated: 'escalated-full',
  failed: 'failed',
  skipped: 'skipped',
};

export function briefRowParts(input: Readonly<{ row: BriefRow }>): BriefRowParts {
  const { row } = input;
  const state = briefState(row);
  const note =
    state.kind === 'halted' && row.partialFiles > 0
      ? countNoun(row.partialFiles, 'partial file')
      : undefined;
  return {
    id: row.id,
    title: row.title,
    state,
    ...(row.retries > 0 && { retries: row.retries }),
    ...(row.durationMs !== null && { duration: row.durationMs }),
    ...(row.file !== null && { file: row.file }),
    ...(row.fileNote !== undefined && { fileNote: row.fileNote }),
    ...(row.extraFiles !== undefined && { extraFiles: row.extraFiles }),
    ...(note !== undefined && { note }),
  };
}

/** The brief the run was inside when it closed wears the run's own ending, in one word. */
function briefState(row: BriefRow): BriefRowParts['state'] {
  if (row.state === 'pending') return { kind: 'pending' };
  if (row.state === 'stopped') return { kind: 'halted', tone: 'cancelled', word: 'stopped' };
  return { kind: 'settled', method: row.method ?? SETTLED_METHODS[row.state] };
}

export function filesRows(view: SummaryView): FileRow[] {
  return (view.files.changed ?? []).map((path) => ({
    path,
    partial: view.files.partial.has(path),
  }));
}
