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
  formatCollapsedSeatLineFromIdentities,
} from '../../../core/crew/identity.js';
import { formatScoreSummary } from '../../../core/formatting.js';
import { SESSIONS_DIR, SPLITBRIEF_DIR } from '../../../core/paths.js';
import { SOFT_SEP } from '../../../core/separators.js';
import { formatTime } from '../../../utils/format-time.js';
import { countNoun } from '../../../utils/pluralize.js';

/**
 * Theme keys, so a row says which colour it wants and the renderer indexes the theme instead of
 * translating a second vocabulary. `link` is the one that is not a top-level key: it is
 * `theme.markdown.link`, the colour every other file path on the screen already wears.
 */
export type CopyTone = 'text' | 'textDim' | 'success' | 'warning' | 'error' | 'link';

export interface CopySegment {
  text: string;
  tone: CopyTone;
}

export interface RunRow {
  label: string;
  /** The value, in reading order; the renderer joins them with ` · `. */
  segments: readonly CopySegment[];
}

export interface FileRow {
  path: string;
  partial: boolean;
}

export interface BriefRowParts {
  id: string;
  title: string;
  state: TaskSummaryState;
  retries?: number | undefined;
  duration?: number | undefined;
  file?: string | undefined;
  note?: string | undefined;
}

export function runRowValue(row: RunRow): string {
  return row.segments.map((segment) => segment.text).join(SOFT_SEP);
}

/** The two finding tallies every review sentence spells the same way. */
export function findingCounts(counts: Readonly<{ critical: number; warning: number }>): string {
  return `${counts.critical} blocking, ${counts.warning} advisory`;
}

/**
 * What the run did, and never what it cost. The record keeps the money and the token counts
 * (`view.cost`, `view.tokens`) for the reader who opens `/usage`; a ledger nobody asked for a price
 * from states the work instead.
 */
export function runRows(view: SummaryView): RunRow[] {
  const rows: RunRow[] = [{ label: 'Review', segments: reviewSegments(view.review) }];
  const packet = packetPath(view);
  if (packet !== null) rows.push({ label: 'Packet', segments: [{ text: packet, tone: 'link' }] });
  rows.push({ label: 'Scope', segments: scopeSegments(view.scope) });
  const quality = view.quality;
  if (quality !== null) {
    rows.push({
      label: 'Briefs',
      segments: [
        {
          text: formatScoreSummary(quality.score, quality, 'quality'),
          tone: quality.passed ? 'text' : 'warning',
        },
      ],
    });
  }
  const phases = phaseSegments(view.phases);
  if (phases.length > 0) rows.push({ label: 'Phases', segments: phases });
  rows.push({ label: 'Session', segments: sessionSegments(view.run) });
  return rows;
}

function reviewSegments(review: ReviewView): CopySegment[] {
  if (review.kind !== 'written') return [{ text: 'not run', tone: 'textDim' }];
  const segments: CopySegment[] = [];
  const verdict = verdictSegment(review.verdict);
  if (verdict !== null) segments.push(verdict);
  segments.push({ text: findingCounts(review.counts), tone: 'text' });
  if (review.evidence.total > 0) {
    segments.push({
      text: `${review.evidence.validated}/${review.evidence.total} briefs validated`,
      tone: 'text',
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

function scopeSegments(scope: ScopeView): CopySegment[] {
  if (scope.kind === 'not-run') return [{ text: 'not checked', tone: 'textDim' }];
  return [
    {
      text: formatScoreSummary(scope.score, {
        errorCount: scope.errors,
        warningCount: scope.warnings,
      }),
      tone: scope.passed ? 'text' : 'warning',
    },
  ];
}

/** One phase would only restate the run clock the header already shows. */
function phaseSegments(phases: SummaryView['phases']): CopySegment[] {
  if (phases.length < 2) return [];
  return phases.map((timing) => ({
    text: `${timing.phase} ${formatTime(timing.ms)}`,
    tone: 'text',
  }));
}

function sessionSegments(run: SummaryView['run']): CopySegment[] {
  const segments: CopySegment[] = [{ text: run.sessionId, tone: 'text' }];
  if (run.mode !== null) segments.push({ text: run.mode, tone: 'text' });
  return segments;
}

/**
 * The crew line the header would paint, laid out to whatever the Run block can spare. The summary
 * has names on record rather than runner blocks, so it enters the layout half directly.
 */
export function crewLine(view: SummaryView, budget: number): string {
  return formatCollapsedSeatLineFromIdentities({
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
        ? 'mixed implementers'
        : `mixed profiles (${seat.profiles.join(', ')})`;
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
    ...(note !== undefined && { note }),
  };
}

/** The brief the run was inside when it closed wears the run's own ending, in one word. */
function briefState(row: BriefRow): TaskSummaryState {
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
