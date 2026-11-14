import { taskSummarySpans } from '../../../components/task-summary.js';
import { CREW_SEAT_ROLES } from '../../../core/crew/seats.js';
import type { GlyphName } from '../../../lib/glyphs.js';
import { configStore } from '../../../stores/project/config.js';
import { truncateTerminalDisplayText } from '../../../utils/display-text/truncate.js';
import { ELLIPSIS } from '../../../utils/display-text/truncate.js';
import { getTerminalCellWidth } from '../../../utils/display-text/width.js';
import { stripTerminalControls } from '../../../utils/display-text/sanitize.js';
import { filePathUrl } from '../../../utils/path/links.js';
import { wrapPathAware } from '../../../utils/display-text/wrap.js';
import { foldRow, foldRowKey } from '../conversation-rows/fold-row.js';
import { segmentedRow } from '../conversation-rows/row-format/rows.js';
import { rowLeadingCells } from '../conversation-rows/row-markers.js';
import type {
  ConversationRow,
  ConversationRowBlock,
  ConversationRowSegment,
} from '../conversation-rows/types.js';
import {
  crewLine,
  factSpans,
  recordFold,
  recordRows,
  runRows,
  type CopyFact,
  type CopySegment,
  type RecordRow,
  type RunRow,
  type SummaryForm,
} from './copy.js';
import { cutFactMiddle, fitFacts } from './fit-facts.js';
import { outcomeLineSpans, outcomeMarker } from './outcome.js';
import type { SummaryView } from './view-model.js';

/** The label column: the widest label and the two spaces after it. */
const LABEL_CELLS = 'Session'.length + 2;

/** A count that leads a fact: `3 criteria`, `2/2 briefs passed`. A time (`2m 50s`) is not one. */
const COUNT_LED = /^(\d+(?:\/\d+)?)( .*)$/u;

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

interface TreeLine {
  label: string;
  seat?: RunRow['seat'];
  spans: ConversationRowSegment[];
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
  if (view === null) return rowBlock(key, [header]);

  const valueWidth = Math.max(1, width - rowLeadingCells('activity-child') - LABEL_CELLS);
  const linesOf = (rows: readonly RecordRow[]) => treeLines(rows, width, valueWidth);
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
    ...rowBlock(key, rows),
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

function rowBlock(key: string, rows: readonly ConversationRow[]): ConversationRowBlock {
  return {
    key,
    rowCount: rows.length,
    renderableUnits: 0,
    createRows: (windowStart, windowEnd) => rows.slice(windowStart, windowEnd),
  };
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

/** The crew by model, unless the header chose the whole model line (`crewNamed`). */
function crewRows(view: SummaryView, budget: number, crewNamed: boolean): RunRow[] {
  if (crewNamed) return [];
  const spans = crewLine(view, budget, { line: 'model' }).map(
    (span): CopySegment => ({
      text: span.text,
      tone: span.seat === undefined ? 'textDim' : CREW_SEAT_ROLES[span.seat],
    }),
  );
  return spans.length === 0 ? [] : [{ label: 'Crew', segments: [{ spans }] }];
}

function treeLines(rows: readonly RecordRow[], width: number, valueWidth: number): TreeLine[] {
  const projectDir = configStore.get().projectDir;
  return rows.flatMap((row): TreeLine[] =>
    'brief' in row
      ? [
          {
            label: '',
            spans: taskSummarySpans({ ...row.brief, width: width - LABEL_CELLS, quiet: true }),
          },
        ]
      : proseLines(row, valueWidth).map((line) => ({
          label: line.label,
          ...(line.seat !== undefined && { seat: line.seat }),
          spans: fitRow(
            line.label === '' ? line.segments : line.segments.map(countLed),
            valueWidth,
          ).map(({ path, ...span }) =>
            path === undefined || projectDir === ''
              ? span
              : { ...span, href: filePathUrl({ path, rootDir: projectDir }) },
          ),
        })),
  );
}

/**
 * A labelled row opens a branch of the tree; a row without a label continues the one above it. A
 * stage label wears the tone of its seat, and every other label stays behind the facts it names.
 */
function treeRow(key: string, line: TreeLine, last: boolean): ConversationRow {
  return segmentedRow(
    key,
    [
      {
        text: line.label.padEnd(LABEL_CELLS),
        tone: line.seat === undefined ? 'textDim' : CREW_SEAT_ROLES[line.seat],
      },
      ...line.spans,
    ],
    last ? 'activity-child-last' : line.label !== '' ? 'activity-child' : 'callout-body',
  );
}

/** A fact of one dim span that a count leads sets the count apart from its words. */
function countLed(fact: CopyFact): CopyFact {
  const [only, ...more] = factSpans(fact);
  if (only === undefined || more.length > 0 || only.tone !== 'textDim' || only.path !== undefined)
    return fact;
  const [, count, words] = COUNT_LED.exec(only.text) ?? [];
  return count === undefined || words === undefined
    ? fact
    : {
        spans: [
          { text: count, tone: 'text' },
          { text: words, tone: 'textDim' },
        ],
      };
}

/** A row too wide for its column sheds whole facts; one fact too wide is cut in the middle. */
function fitRow(facts: RunRow['segments'], budget: number): CopySegment[] {
  const spans = facts.map(factSpans);
  const fitted = fitFacts(spans, budget);
  if (fitted.length > 0) return fitted;
  const [first] = spans;
  return first === undefined ? [] : cutFactMiddle(first, budget);
}

/** A prose row wraps at words, each further line under the text after its lead. */
function proseLines(row: RunRow, width: number): RunRow[] {
  const [fact] = row.segments;
  if (row.hang === undefined || fact === undefined || 'spans' in fact) return [row];
  const text = stripTerminalControls(fact.text);
  const lead = text.slice(0, row.hang);
  const indent = ' '.repeat(getTerminalCellWidth(lead));
  const lineWidth = Math.max(1, width - indent.length);
  const wrapped = wrapPathAware(text.slice(row.hang), lineWidth).split('\n');
  const kept = row.maxLines === undefined ? wrapped : wrapped.slice(0, row.maxLines);
  const last = kept.length - 1;
  return kept.map((line, index) => ({
    label: index === 0 ? row.label : '',
    segments: [
      {
        text: `${index === 0 ? lead : indent}${
          index === last && kept.length < wrapped.length
            ? truncateTerminalDisplayText(`${line}${ELLIPSIS}`, lineWidth)
            : line
        }`,
        tone: fact.tone,
      },
    ],
  }));
}
