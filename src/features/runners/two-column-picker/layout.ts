import { getScrollViewportContentWidth } from '../../../components/scrollbar.js';
import { overlayListRows } from '../../../components/pickers/scroll-offset.js';
import { getTerminalCellWidth } from '../../../utils/display-text/width.js';
import { BYLINE_ROWS } from './hint.js';
import { wrapOnWords } from '../picker/byline.js';
import { overlayRect } from '../../../core/navigation/overlay-rect.js';

const INNER_PADDING = 4;
export const COLUMN_GAP = 3;
export const INNER_CHROME_ROWS = 4;
/** The least room between the title and a step label that shares its row. */
const HEAD_GAP = 2;

export function pickerLayout(input: {
  minRowWidth: number;
  cols: number;
  rows: number;
  title: string;
  stepLabel: string | undefined;
}) {
  const { cols, rows, title, stepLabel } = input;
  const { width: totalBoxWidth, height } = overlayRect({ cols, rows, density: 'wide' });
  const splitWidth = Math.floor((totalBoxWidth - COLUMN_GAP) / 2);
  // Each list reserves two cells for the scrollbar, in addition to the panel padding.
  const singlePane = getScrollViewportContentWidth(splitWidth - INNER_PADDING) < input.minRowWidth;
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
  const headerRows = 2 + (headStacked ? stepLabelLines.length : 0);
  const maxVisible = overlayListRows(height - INNER_CHROME_ROWS, headerRows, BYLINE_ROWS + 1);
  const columnHeight = maxVisible + INNER_CHROME_ROWS;
  // The odd cell goes to the Models column, which carries the longer strings.
  const leftBoxWidth = singlePane ? totalBoxWidth : splitWidth;
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
