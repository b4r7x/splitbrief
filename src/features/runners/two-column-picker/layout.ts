import { availableRows } from '../../../components/pickers/scroll-offset.js';
import { getTerminalCellWidth } from '../../../utils/display-text/width.js';
import { wrapOnWords } from '../picker/byline.js';
import { overlayWidth } from '../../../core/navigation/overlay-rect.js';

const INNER_PADDING = 4;
export const COLUMN_GAP = 3;
const OUTER_CHROME_ROWS = 6;
export const INNER_CHROME_ROWS = 4;
/** The least room between the title and a step label that shares its row. */
const HEAD_GAP = 2;
const VISIBLE_ROWS_CAP = 18;

export function pickerLayout(input: {
  cols: number;
  rows: number;
  title: string;
  stepLabel: string | undefined;
}) {
  const { cols, rows, title, stepLabel } = input;
  const singlePane = cols < 80;
  const totalBoxWidth = overlayWidth({ cols, density: 'wide' });
  // The columns reserve every wrapped label row so the header stays inside the viewport.
  const headStacked =
    stepLabel !== undefined &&
    stepLabel !== '' &&
    getTerminalCellWidth(title) + HEAD_GAP + getTerminalCellWidth(stepLabel) > totalBoxWidth;
  const stepLabelLines = headStacked
    ? wrapOnWords(stepLabel, totalBoxWidth, Number.POSITIVE_INFINITY).lines
    : stepLabel
      ? [stepLabel]
      : [];
  const maxVisible = Math.min(
    availableRows({
      rows,
      chromeRows: OUTER_CHROME_ROWS + INNER_CHROME_ROWS + (headStacked ? stepLabelLines.length : 0),
    }),
    VISIBLE_ROWS_CAP,
  );
  const columnHeight = maxVisible + INNER_CHROME_ROWS;
  // The odd cell goes to the Models column, which carries the longer strings.
  const leftBoxWidth = singlePane ? totalBoxWidth : Math.floor((totalBoxWidth - COLUMN_GAP) / 2);
  const rightBoxWidth = singlePane ? totalBoxWidth : totalBoxWidth - COLUMN_GAP - leftBoxWidth;
  const leftContentWidth = Math.max(1, leftBoxWidth - INNER_PADDING);
  const rightContentWidth = Math.max(1, rightBoxWidth - INNER_PADDING);

  return {
    singlePane,
    totalBoxWidth,
    headStacked,
    stepLabelLines,
    maxVisible,
    columnHeight,
    leftBoxWidth,
    rightBoxWidth,
    leftContentWidth,
    rightContentWidth,
  };
}
