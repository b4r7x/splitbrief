import { CREW_SEAT_ROLES } from '../../../../core/crew/seats.js';
import { configStore } from '../../../../stores/project/config.js';
import { ELLIPSIS, truncateTerminalDisplayText } from '../../../../utils/display-text/truncate.js';
import { getTerminalCellWidth } from '../../../../utils/display-text/width.js';
import { stripTerminalControls } from '../../../../utils/display-text/sanitize.js';
import { wrapPathAware } from '../../../../utils/display-text/wrap.js';
import { filePathUrl } from '../../../../utils/path/links.js';
import { taskSummarySpans } from '../../components/task-summary/spans.js';
import { factSpans } from '../../closed/copy/rows.js';
import type { CopyFact, CopySegment, RecordRow, RunRow } from '../../closed/copy/types.js';
import { cutFactMiddle, fitFacts } from '../../closed/fit-facts.js';
import type { ConversationRow, ConversationRowBlock, ConversationRowSegment } from '../types.js';
import { rowLeadingCells } from './markers.js';
import { segmentedRow } from './rows.js';

/** The label column: the widest label and the two spaces after it. */
export const LABEL_CELLS = 'Session'.length + 2;

/** A count that leads a fact: `3 criteria`, `2/2 briefs passed`. A time (`2m 50s`) is not one. */
const COUNT_LED = /^(\d+(?:\/\d+)?)( .*)$/u;

export interface TreeLine {
  label: string;
  seat?: RunRow['seat'];
  spans: ConversationRowSegment[];
}

export function treeValueWidth(width: number): number {
  return Math.max(1, width - rowLeadingCells('activity-child') - LABEL_CELLS);
}

export function treeBlock(
  key: string,
  rows: readonly ConversationRow[],
  renderableUnits: number,
): ConversationRowBlock {
  return {
    key,
    rowCount: rows.length,
    renderableUnits,
    createRows: (windowStart, windowEnd) => rows.slice(windowStart, windowEnd),
  };
}

export function treeLines(rows: readonly RecordRow[], width: number): TreeLine[] {
  const valueWidth = treeValueWidth(width);
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
export function treeRow(key: string, line: TreeLine, last: boolean): ConversationRow {
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
export function countLed(fact: CopyFact): CopyFact {
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
export function fitRow(facts: RunRow['segments'], budget: number): CopySegment[] {
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
