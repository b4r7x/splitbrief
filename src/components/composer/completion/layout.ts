import { availableRows } from '../../pickers/scroll-window.js';

const SUGGESTION_PANEL_CHROME_ROWS = 4;
const SUGGESTION_PANEL_SAFETY_MARGIN = 8;
const SUGGESTION_PANEL_HARD_CAP = 8;
const SUGGESTION_PANEL_FLOOR = 3;

export function computeCompletionCap(terminalRows: number, inputVisibleRows: number): number {
  return Math.min(
    SUGGESTION_PANEL_HARD_CAP,
    availableRows({
      rows: terminalRows,
      chromeRows: inputVisibleRows + SUGGESTION_PANEL_CHROME_ROWS + SUGGESTION_PANEL_SAFETY_MARGIN,
      floor: SUGGESTION_PANEL_FLOOR,
    }),
  );
}

// The overlay opens upward via a negative margin, so this must equal the panel's TRUE rendered
// height: the visible content rows plus the panel chrome (divider + footer + the two border lines).
// Scroll position is shown by the in-gutter thumb, not by separate indicator rows, so nothing else
// is added — overcounting here is what leaves a floating gap above the input.
export function computeCompletionOverlayRows(args: {
  itemCount: number;
  maxVisible: number;
  hasFuzzyMatch?: boolean | undefined;
  hasEmptyMessage?: boolean | undefined;
}): number {
  const rowCount =
    args.itemCount > 0
      ? Math.min(args.itemCount, args.maxVisible)
      : args.hasFuzzyMatch || args.hasEmptyMessage
        ? 1
        : 0;
  if (rowCount === 0) return 0;
  return rowCount + SUGGESTION_PANEL_CHROME_ROWS;
}
