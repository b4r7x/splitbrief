import { overlayWidth } from '../../core/navigation/overlay-rect.js';
import { getTerminalCellWidth } from '../../utils/display-text.js';
import { HOME_LOGO_ROWS } from './logo.js';

/** The lead sentence and the example under it, above the composer box. */
export const HOME_LEAD_ROWS = 2;

// The lead is the only sentence that says what a run does, and half of it says less than nothing.
// A box too narrow for the whole sentence takes a shorter one, never the first two thirds of this.
const HOME_LEADS: readonly string[] = [
  'Describe a change. SPLITBRIEF plans it, builds it in small briefs, and reviews the diff.',
  'Describe a change. SPLITBRIEF plans it, builds it, reviews the diff.',
];
const HOME_LEAD_SHORTEST = 'Describe a change. SPLITBRIEF plans, builds, reviews.';

export function homeLead(width: number): string {
  return HOME_LEADS.find((lead) => getTerminalCellWidth(lead) <= width) ?? HOME_LEAD_SHORTEST;
}

interface HomeLayoutInput {
  cols: number;
  rows: number;
  sessionCount?: number;
  sessionsFocused?: boolean | undefined;
}

interface HomeLayout {
  width: number;
  inputBottomMargin: number;
  recentSessionLimit: number;
  showHiddenCount: boolean;
  /** Rows the session list may spend; unspent rows are the body's slack. */
  sessionCapacity: number;
}

interface SessionLimitInput {
  cols: number;
  rows: number;
  inputBottomMargin: number;
  sessionCount: number;
  sessionsFocused: boolean;
}

const FOCUSED_FILTER_BLOCK_ROWS = 4;
const FOCUSED_SELECTION_ERROR_ROWS = 1;
const COMPACT_CONFIG_BLOCK_ROWS = 2;
const HOME_MAX_WIDTH = 108;

export function homeConfigBlockRows(rows: number): number {
  return rows >= 24 ? 4 : COMPACT_CONFIG_BLOCK_ROWS;
}

function getContentAwareSessionLimit(input: SessionLimitInput): {
  recentSessionLimit: number;
  showHiddenCount: boolean;
  sessionCapacity: number;
} {
  const { cols, rows, inputBottomMargin, sessionCount, sessionsFocused } = input;
  // The lead sentence and its example, the hint row, the three composer rows, and the dock margin.
  const inputDock = HOME_LEAD_ROWS + 1 + 3 + inputBottomMargin;
  const bodyGaps = 2;
  const logoBlock = HOME_LOGO_ROWS + 1;
  const configBlock = homeConfigBlockRows(rows);
  const sessionsChrome = 1 + (cols >= 120 ? 1 : 0) + 1;
  const baseAvailable = rows - (inputDock + bodyGaps + logoBlock + configBlock + sessionsChrome);
  const baseCapacity = Math.max(0, baseAvailable);
  if (sessionsFocused) {
    const listRows = Math.max(0, baseCapacity - FOCUSED_FILTER_BLOCK_ROWS);
    // The filter block outranks the row count, and the row count outranks the
    // error line: where reserving the error row would leave nothing to select,
    // the last session row keeps it and the error borrows the body's slack.
    const capacity =
      listRows > FOCUSED_SELECTION_ERROR_ROWS ? listRows - FOCUSED_SELECTION_ERROR_ROWS : listRows;
    return { recentSessionLimit: capacity, showHiddenCount: false, sessionCapacity: capacity };
  }
  if (sessionCount <= baseCapacity) {
    return {
      recentSessionLimit: baseCapacity,
      showHiddenCount: false,
      sessionCapacity: baseCapacity,
    };
  }
  if (baseCapacity <= 1) {
    return {
      recentSessionLimit: baseCapacity,
      showHiddenCount: false,
      sessionCapacity: baseCapacity,
    };
  }
  return {
    recentSessionLimit: baseCapacity - 1,
    showHiddenCount: true,
    sessionCapacity: baseCapacity,
  };
}

export function getHomeLayout({
  cols,
  rows,
  sessionCount = 0,
  sessionsFocused = false,
}: HomeLayoutInput): HomeLayout {
  const width = Math.min(overlayWidth({ cols, density: 'wide' }), HOME_MAX_WIDTH);
  const inputBottomMargin = rows >= 38 ? 2 : rows >= 30 ? 1 : 0;
  const { recentSessionLimit, showHiddenCount, sessionCapacity } = getContentAwareSessionLimit({
    cols,
    rows,
    inputBottomMargin,
    sessionCount,
    sessionsFocused,
  });

  return {
    width,
    inputBottomMargin,
    recentSessionLimit,
    showHiddenCount,
    sessionCapacity,
  };
}
