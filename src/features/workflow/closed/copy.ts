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
  REVIEW_NONE,
  formatCollapsedSeatSpansFromIdentities,
  type CrewSeatId,
  type SeatLineSpan,
} from '../../../core/crew/identity.js';
import { formatStageLabel } from '../../../core/phase-display.js';
import { formatScoreSummaryParts } from '../../../core/formatting.js';
import { SESSIONS_DIR, SPLITBRIEF_DIR } from '../../../core/paths.js';
import { arrowSep, SOFT_SEP } from '../../../core/separators.js';
import { formatTime } from '../../../utils/format/time.js';
import { countNoun } from '../../../utils/pluralize.js';
import type { SetAside } from '../../../core/schemas/review.js';
import { findingFacts, setAsideLabel, setAsideLine } from '../../../core/review/verdict.js';
import { stateTone, type StateTone } from '../../../core/theme/state-tone.js';
import { passedFractionSpans } from '../display/build-progress.js';

/**
 * Theme keys, so a row says which colour it wants and the renderer indexes the theme instead of
 * translating a second vocabulary.
 */
export type CopyTone = 'text' | StateTone | 'planner' | 'implementer' | 'reviewer';

export interface CopySegment {
  text: string;
  tone: CopyTone;
  /** The changed file this text names, which the block links into the project. */
  path?: string;
}

export type CopyFact = CopySegment | Readonly<{ spans: readonly CopySegment[] }>;

export function factSpans(fact: CopyFact): readonly CopySegment[] {
  return 'spans' in fact ? fact.spans : [fact];
}

export interface RunRow {
  /** Empty on a follow-on row, which reads as part of the labelled row above it. */
  label: string;
  /** The seat a stage row reports on; its label wears the tone of that seat. */
  seat?: CrewSeatId;
  /** Each fact fits as one unit; the renderer joins facts with ` · `. */
  segments: readonly CopyFact[];
  /**
   * A prose row's lead length: its one fact wraps at words, each further line under the text
   * after the lead, so a sentence is never cut. A row without it is cut in the middle, as a path.
   */
  hang?: number;
  /** The rows a prose row may take; the summary quotes a note, the record keeps it whole. */
  maxLines?: number;
}

/** A row of the whole record: a run row, or one brief in the words the transcript settled it with. */
export type RecordRow = RunRow | Readonly<{ brief: BriefRowParts }>;

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

/** How many review notes the summary quotes, and how many rows each one may take. */
const SUMMARY_NOTES = 2;
const NOTE_LINES = 2;

/** The summary whole, or only its labelled rows for a view too short to seat it whole. */
export type SummaryForm = 'whole' | 'labelled';

/**
 * The run in one row per stage: what the plan asked for, what the build did, what the review
 * said and what landed. It never says what the run cost: the view carries no money and no token
 * counts, and the record keeps them for the reader who opens `/usage`. Every brief, every file
 * and every earlier finding stay in `recordRows`.
 */
export function runRows(view: SummaryView, form: SummaryForm = 'whole'): RunRow[] {
  const times = phaseTimes(view.phases, view.ran);
  const rows: RunRow[] = [
    ...stageRow('plan', planSegments(view), times.get('planning')),
    ...stageRow('build', buildSegments(view), times.get('implementing')),
    ...stageRow(
      'review',
      [...reviewSegments(view.review, { evidence: false }), ...criteriaSegments(view)],
      times.get('review'),
    ),
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

/** A stage with nothing to state and no time on record has no row. */
function stageRow(seat: CrewSeatId, facts: CopyFact[], time: string | undefined): RunRow[] {
  const segments =
    time === undefined ? facts : [...facts, { text: time, tone: 'textDim' as const }];
  return segments.length === 0 ? [] : [{ label: formatStageLabel(seat), seat, segments }];
}

function planSegments(view: SummaryView): CopyFact[] {
  const { plannedBriefs, planCriteria } = view.digest;
  return [
    ...(plannedBriefs === null || plannedBriefs === 0
      ? []
      : [{ text: countNoun(plannedBriefs, 'brief'), tone: 'textDim' as const }]),
    ...(planCriteria === null
      ? []
      : [{ text: countNoun(planCriteria, 'criterion', 'criteria'), tone: 'textDim' as const }]),
  ];
}

function buildSegments(view: SummaryView): CopyFact[] {
  const { total, passed, failed, rows } = view.briefs;
  if (total === 0) return [{ text: 'no briefs', tone: 'textDim' }];
  const consulted = rows.filter((row) => row.method === 'consulted').length;
  const escalated = rows.filter((row) => row.state === 'escalated').length;
  const skipped = rows.filter((row) => row.state === 'skipped').length;
  const retries = rows.reduce((sum, row) => sum + row.retries, 0);
  const fixBriefs = view.digest.fixBriefs;
  return [
    { spans: passedFractionSpans(`${passed}/${total} briefs`) },
    ...(failed > 0 ? [{ text: `${failed} failed`, tone: stateTone('failed') }] : []),
    ...(fixBriefs > 0 ? [{ text: `${fixBriefs} from fix cycles`, tone: 'textDim' as const }] : []),
    ...(consulted > 0 ? [{ text: `${consulted} consulted`, tone: 'textDim' as const }] : []),
    ...(escalated > 0 ? [{ text: `${escalated} escalated`, tone: stateTone('attention') }] : []),
    ...(skipped > 0 ? [{ text: `${skipped} skipped`, tone: stateTone('pending') }] : []),
    ...(retries > 0
      ? [{ text: countNoun(retries, 'retry', 'retries'), tone: 'textDim' as const }]
      : []),
  ];
}

function criteriaSegments(view: SummaryView): CopyFact[] {
  const criteria = view.digest.criteria;
  if (view.review.kind !== 'written' || criteria === null) return [];
  return [{ text: `${criteria.passed}/${criteria.total} criteria`, tone: 'textDim' }];
}

/**
 * The notes of the review of record: where each one points, then what it says as prose. The
 * summary quotes the first notes in two rows each; the record keeps every note whole.
 */
function noteRows(view: SummaryView, options: Readonly<{ quoted: boolean }>): RunRow[] {
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
function earlierReviewRows(view: SummaryView): RunRow[] {
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

/** What the run changed: the count, then one row per listed file. */
function changedRows(view: SummaryView, files: readonly FileRow[]): RunRow[] {
  const changed = view.files.changed;
  if (changed === null || changed.length === 0) return [];
  const testFiles = view.digest.testFiles;
  const partial = view.files.partial.size;
  return [
    {
      label: 'Files',
      segments: [
        { text: countNoun(changed.length, 'file'), tone: 'textDim' },
        ...(testFiles > 0
          ? [{ text: countNoun(testFiles, 'test file'), tone: 'textDim' as const }]
          : []),
        ...(partial > 0 ? [{ text: `${partial} partial`, tone: 'warning' as const }] : []),
      ],
    },
    ...files.map((file): RunRow => {
      const path: CopySegment = { text: file.path, tone: 'textDim', path: file.path };
      return {
        label: '',
        segments: [
          file.partial
            ? {
                spans: [
                  path,
                  { text: SOFT_SEP, tone: 'textDim' },
                  { text: 'partial', tone: 'warning' },
                ],
              }
            : path,
        ],
      };
    }),
  ];
}

function applyUndoRows(applyUndo: SummaryView['applyUndo']): RunRow[] {
  if (applyUndo === null) return [];
  const conflicts = applyUndo.conflicts.length;
  return [
    {
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
    },
  ];
}

function qualityRows(quality: SummaryView['quality']): RunRow[] {
  if (quality === null) return [];
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
  return [{ label: 'Briefs', segments: [{ spans }] }];
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
    ...stageRow('plan', planSegments(view), times.get('planning')),
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

/**
 * The closed run reads the final review's record. A run that reviewed each task can still end before
 * its final review, so the absence names that review; a final review that ran without a verdict says so.
 */
export function unwrittenReviewText(review: Exclude<ReviewView, { kind: 'written' }>): string {
  if (review.kind === 'none') return 'no review';
  return review.kind === 'failed' ? 'final review no verdict' : 'final review not run';
}

/** The summary leaves out the validated briefs: its Build row states them. */
function reviewSegments(
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
function acceptedRows(accepted: SummaryView['accepted']): RunRow[] {
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
 * many findings blocked it, then one indented prose row per finding, so a fix cycle keeps its
 * reason whole.
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
function setAsideRows(setAside: readonly SetAside[], lead: string): RunRow[] {
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

/**
 * Each phase's time, in the whole seconds that add up to the run's own: the whole seconds of the
 * run are split by largest remainder, where flooring each phase alone would lose up to a second each.
 */
function phaseTimes(
  phases: SummaryView['phases'],
  ran: number | null,
): Map<SummaryView['phases'][number]['phase'], string> {
  const seconds = (ms: number) => Math.floor(ms / 1000);
  const whole = seconds(ran ?? phases.reduce((sum, timing) => sum + timing.ms, 0));
  const short = whole - phases.reduce((sum, timing) => sum + seconds(timing.ms), 0);
  const roundedUp = new Set(
    phases
      .map((timing, index) => ({ index, remainder: timing.ms % 1000 }))
      .sort((left, right) => right.remainder - left.remainder)
      .slice(0, Math.max(0, short))
      .map((entry) => entry.index),
  );
  return new Map(
    phases.map((timing, index) => [
      timing.phase,
      formatTime((seconds(timing.ms) + (roundedUp.has(index) ? 1 : 0)) * 1000),
    ]),
  );
}

function sessionSegments(run: SummaryView['run']): CopySegment[] {
  return [{ text: run.sessionId, tone: 'textDim' }];
}

/**
 * The crew line the header would paint, laid out to whatever the Run block can spare. The summary
 * has names on record rather than runner blocks, so it enters the layout half directly. A budget
 * that cannot seat every name falls back to the tool words; `line` lays out that one line alone.
 */
export function crewLine(
  view: Pick<SummaryView, 'seats'>,
  budget: number,
  options: Readonly<{ line?: 'model' | 'tool' | undefined }> = {},
): readonly SeatLineSpan[] {
  const review = view.seats.review;
  const toolLine = options.line === 'tool';
  const word = (seat: SeatView): string =>
    toolLine ? (seatToolWord(seat) ?? seatWord(seat)) : seatWord(seat);
  const planTool = seatToolWord(view.seats.plan);
  const buildTool = seatToolWord(view.seats.build);
  const reviewTool = seatToolWord(review);
  return formatCollapsedSeatSpansFromIdentities({
    plan: word(view.seats.plan),
    build: word(view.seats.build),
    review: review.kind === 'inherits' ? null : review.kind === 'none' ? REVIEW_NONE : word(review),
    ...(options.line === undefined && {
      tools: {
        ...(planTool !== undefined && { plan: planTool }),
        ...(buildTool !== undefined && { build: buildTool }),
        ...(reviewTool !== undefined && { review: reviewTool }),
      },
    }),
    budget,
  });
}

/** The command a named seat takes when the line is laid out by tool words. */
function seatToolWord(seat: SeatView): string | undefined {
  return seat.kind === 'named' ? seat.tool : undefined;
}

/**
 * A seat as the sidebar crew names it, in the pieces a narrow row breaks between: a named seat
 * with its tool, like the live crew rows; a move after each arrow; a back-and-forth after each comma.
 */
export function seatIdentityPieces(seat: SeatView): string[] {
  switch (seat.kind) {
    case 'named':
      return [seat.full];
    case 'moved':
      return movedPieces(seat);
    default:
      return [seatWord(seat)];
  }
}

// A seat that left one tool for good reads as the move; one that went back and forth has no
// single move to name, so it says how much each tool did.
function movedPieces(seat: Extract<SeatView, { kind: 'moved' }>): string[] {
  const last = seat.seats.length - 1;
  if (seat.contiguous) {
    const arrow = arrowSep().trimEnd();
    return seat.seats.map((moved, index) =>
      index < last ? `${moved.short}${arrow}` : moved.short,
    );
  }
  return seat.seats.map((moved, index) => {
    const share =
      index === 0
        ? `${countNoun(moved.briefs, 'brief')} on ${moved.short}`
        : `${moved.briefs} on ${moved.short}`;
    return index < last ? `${share},` : share;
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
    case 'moved':
      return movedPieces(seat).join(' ');
    case 'inherits':
      return PLANNER_INHERITANCE.mark;
    case 'none':
      return REVIEW_NONE.mark;
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
  return (view.files.changed ?? []).map((path) => fileRow(view, path));
}

function fileRow(view: SummaryView, path: string): FileRow {
  return { path, partial: view.files.partial.has(path) };
}
