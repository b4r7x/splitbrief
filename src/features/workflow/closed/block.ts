import {
  treeBlock,
  treeLines,
  treeRow,
  treeValueWidth,
  type TreeLine,
} from '../conversation-rows/row-format/tree.js';
import { CREW_SEAT_ROLES } from '../../../core/crew/seats.js';
import type { GlyphName } from '../../../lib/glyphs.js';
import { foldRow, foldRowKey } from '../conversation-rows/fold-row.js';
import { segmentedRow } from '../conversation-rows/row-format/rows.js';
import type { ConversationRow, ConversationRowBlock } from '../conversation-rows/types.js';
import { crewLineRows } from './copy/crew-line.js';
import { recordRows } from './copy/rows.js';
import { recordFold, runRows } from './copy/rows.js';
import type { SummaryForm } from './copy/types.js';
import type { RecordRow, RunRow } from './copy/types.js';
import type { CopySegment } from './copy/types.js';
import { outcomeLineSpans, outcomeMarker } from './outcome.js';
import type { SummaryView } from './view-model.js';

/** The settled state behind each outcome mark; the done mark needs none. */
const DONE_AS: Partial<Record<GlyphName, NonNullable<ConversationRow['doneAs']>>> = {
  statusWarning: 'attention',
  statusCancelled: 'cancelled',
};

export interface ClosedBlockInput {
  /** The key the fold state of the block is stored under, from `closedBlockKey`. */
  key: string;
  /** Null when the run closed without leaving a record to read. */
  view: SummaryView | null;
  width: number;
  /**
   * The rows the transcript shows at once: a summary taller than that keeps its labelled rows, and
   * a view shorter than those keeps as many as fit between the outcome and the fold.
   */
  viewportRows: number;
  /** Whether the header already names the whole crew, so the block does not name it twice. */
  crewNamed: boolean;
  /** The whole record: every brief, every file and every earlier review. */
  expanded: boolean;
}

/** One run has one fold, and the scroll store keeps fold state across runs, so the key names the run. */
export function closedBlockKey(sessionId: string): string {
  return `closed-block:${sessionId}`;
}

/**
 * The last rows of a closed run's transcript, in the grammar of an activity batch: the outcome as
 * the header, one row per stage, and one fold that opens the whole record. It counts as no
 * renderable unit: it is not an event the run emitted.
 */
export function closedTranscriptBlock(input: ClosedBlockInput): ConversationRowBlock {
  const { key, view, width, viewportRows, crewNamed, expanded } = input;
  const header = headerRow(key, view, width);
  if (view === null) return treeBlock(key, [header], 0);

  const valueWidth = treeValueWidth(width);
  const linesOf = (rows: readonly RecordRow[]) => treeLines(rows, width);
  const crew = linesOf(crewRows(view, valueWidth, crewNamed));
  const whole = [...crew, ...linesOf(runRows(view, 'whole'))];
  // The header and the fold stand with the summary; the outcome must stay on the screen.
  const room = viewportRows - 2;
  const form: SummaryForm = whole.length > room ? 'labelled' : 'whole';
  const labelled = form === 'whole' ? [] : linesOf(runRows(view, 'labelled'));
  const summary = form === 'whole' ? whole : fitLabelled(crew, labelled, room);
  const record = [...crew, ...linesOf(recordRows(view))];
  // A cut from the bottom took the row that closed the tree, so the fold closes it.
  const foldLast = !expanded && labelled.length > room;
  const body = (expanded ? record : summary).map((line, index, lines) =>
    treeRow(`${key}:${index}`, line, !foldLast && index === lines.length - 1),
  );
  const foldIn = foldRow({ foldKey: key, expanded, hidden: recordFold(view, form), width });
  const fold = foldLast ? { ...foldIn, kind: 'activity-child-last' as const } : foldIn;
  const rows = expanded
    ? [header, fold, ...body]
    : foldLast
      ? [header, ...body, fold]
      : [header, ...body.slice(0, -1), fold, ...body.slice(-1)];
  return {
    ...treeBlock(key, rows, 0),
    foldRowKey: foldRowKey(key),
    toggledRowCount: rows.length + (expanded ? -1 : 1) * (record.length - summary.length),
  };
}

/**
 * The labelled rows that fit in `room`, one line each. A view too short for all of them drops the
 * crew first, then rows from the bottom up, so the plan stays longest.
 */
function fitLabelled(
  crew: readonly TreeLine[],
  lines: readonly TreeLine[],
  room: number,
): TreeLine[] {
  return crew.length + lines.length > room
    ? lines.slice(0, Math.max(0, room))
    : [...crew, ...lines];
}

/** The verdict is the one bold word; a stage word keeps its seat tone. */
function headerRow(key: string, view: SummaryView | null, width: number): ConversationRow {
  const marker = outcomeMarker(view);
  const doneAs = DONE_AS[marker.glyph];
  return {
    ...segmentedRow(
      `${key}:outcome`,
      outcomeLineSpans(view, width).map((span, index) => ({
        text: span.text,
        tone: span.seat === undefined ? span.tone : CREW_SEAT_ROLES[span.seat],
        ...(index === 0 && { bold: true }),
      })),
      'activity',
    ),
    markerTone: marker.tone,
    ...(doneAs !== undefined && { doneAs }),
  };
}

// A narrow Run block wraps the crew onto this many rows rather than leave a seat out.
const CREW_MAX_ROWS = 3;

/**
 * The crew by model, unless the header chose the whole model line (`crewNamed`): every seat
 * whole, on the `Crew` row and the rows under it.
 */
function crewRows(view: SummaryView, budget: number, crewNamed: boolean): RunRow[] {
  if (crewNamed) return [];
  return crewLineRows(view, budget, { line: 'model', rows: CREW_MAX_ROWS }).map(
    (row, index): RunRow => ({
      label: index === 0 ? 'Crew' : '',
      segments: [
        {
          spans: row.map(
            (span): CopySegment => ({
              text: span.text,
              tone: span.seat === undefined ? 'textDim' : CREW_SEAT_ROLES[span.seat],
            }),
          ),
        },
      ],
    }),
  );
}
