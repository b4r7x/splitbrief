import { SOFT_SEP } from '../../../core/separators.js';
import { segmentsForRowText, getTerminalCellWidth } from '../../../utils/display-text/width.js';
import { wrappedProseSegments } from '../conversation-rows/row-format/text.js';
import type { ConversationRowSegment } from '../conversation-rows/types.js';
import { getChromeContentWidth } from '../layout/chrome-rows.js';

/** A wrapped consequence hangs in from its label, so a continuation never reads as another row. */
const CONSEQUENCE_HANG = '  ';

// A consequence is a list of clauses. A row breaks after a `;` wherever the next clause fits on the
// line below, so no line ends on half a clause (`do` above `not start T003`).
function wrapClauses(
  source: readonly ConversationRowSegment[],
  width: number,
): ConversationRowSegment[][] {
  const text = source.map((part) => part.text).join('');
  const lines: ConversationRowSegment[][] = [];
  let current: ConversationRowSegment[] = [];
  let offset = 0;
  for (const clause of text.split(/(?<=;) /u)) {
    const clauseParts = segmentsForRowText(source, clause, offset);
    const currentText = current.map((part) => part.text).join('');
    const joined = [
      ...current,
      ...(currentText === '' ? [] : segmentsForRowText(source, ' ', offset - 1)),
      ...clauseParts,
    ];
    if (getTerminalCellWidth(joined.map((part) => part.text).join('')) <= width) {
      current = joined;
    } else if (getTerminalCellWidth(clause) <= width) {
      lines.push(current);
      current = clauseParts;
    } else {
      const wrapped = wrappedProseSegments(joined, width);
      lines.push(...wrapped.slice(0, -1));
      current = wrapped.at(-1) ?? [];
    }
    offset += clause.length + 1;
  }
  return [...lines, current];
}

export function stopMenuLayout<
  Row extends { readonly label: string; readonly consequence: string },
>(rows: readonly Row[], cols: number) {
  // The sheet stacks on the composer inside the gutter, so it takes the composer's width and the
  // two boxes share both edges.
  const width = getChromeContentWidth(cols);
  const innerWidth = Math.max(1, width - 6);
  const options = rows.map((row) => {
    const source: ConversationRowSegment[] = [
      { text: row.label, tone: 'text' },
      { text: SOFT_SEP, tone: 'textDim' },
      { text: row.consequence, tone: 'textDim' },
    ];
    const parts = wrapClauses(source, Math.max(1, innerWidth - CONSEQUENCE_HANG.length)).map(
      (line, index) => {
        return index === 0
          ? line
          : [{ text: CONSEQUENCE_HANG, tone: 'textDim' } satisfies ConversationRowSegment, ...line];
      },
    );
    return { row, parts, lines: parts.map((line) => line.map((part) => part.text).join('')) };
  });
  // Every row states its consequence, so the sheet is exactly as tall as what it paints whichever
  // row is selected: the transcript above holds still as the cursor moves, and no row stands blank.
  const bodyRows = options.reduce((total, option) => total + option.lines.length, 0);
  return { width, bodyRows, height: bodyRows + 4, options };
}

/**
 * What a box of `boxHeight` rows paints around `bodyRows` action rows. The actions go first: a
 * shorter box drops the legend, then the border, then the title, and then the list scrolls.
 */
export function stopMenuChrome(boxHeight: number, bodyRows: number) {
  const spareRows = boxHeight - bodyRows;
  return {
    framed: spareRows >= 3,
    titled: spareRows >= 1,
    legend: spareRows >= 4,
    listRows: Math.min(bodyRows, boxHeight),
    extraRows: Math.max(0, spareRows - 4),
  };
}
