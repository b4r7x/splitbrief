import { availableRows, computeScrollOffset } from '../pickers/picker-utils.js';

const SUGGESTION_PANEL_CHROME_ROWS = 4;
const SUGGESTION_PANEL_SAFETY_MARGIN = 8;
const SUGGESTION_PANEL_HARD_CAP = 8;
const SUGGESTION_PANEL_FLOOR = 3;

export function computeSuggestionsCap(terminalRows: number, inputVisibleRows: number): number {
  return Math.min(
    SUGGESTION_PANEL_HARD_CAP,
    availableRows(
      terminalRows,
      inputVisibleRows + SUGGESTION_PANEL_CHROME_ROWS + SUGGESTION_PANEL_SAFETY_MARGIN,
      SUGGESTION_PANEL_FLOOR,
    ),
  );
}

export function computeSuggestionOverlayRows(args: {
  itemCount: number;
  selectedIndex: number;
  maxVisible: number;
  hasFuzzyMatch?: boolean | undefined;
}): number {
  const rowCount = args.itemCount > 0
    ? Math.min(args.itemCount, args.maxVisible)
    : args.hasFuzzyMatch ? 1 : 0;
  if (rowCount === 0) return 0;

  const scrollOffset = computeScrollOffset(args.selectedIndex, args.maxVisible, args.itemCount);
  const indicatorRows = args.itemCount > 0
    ? Number(scrollOffset > 0) + Number(scrollOffset + args.maxVisible < args.itemCount)
    : 0;
  return rowCount + indicatorRows + SUGGESTION_PANEL_CHROME_ROWS;
}
