import { createStore, storeBase } from './create-store.js';

const SMALL_SCREEN_THRESHOLD = 120;
const DEFAULT_PANEL_GUTTER = 4;
const DEFAULT_SMALL_PANEL_WIDTH = 76;
const DEFAULT_LARGE_PANEL_WIDTH = 110;

interface TerminalSize {
  cols: number;
  rows: number;
  isSmall: boolean;
}

const measure = (): TerminalSize => {
  const cols = process.stdout.columns ?? 80;
  const rows = process.stdout.rows ?? 24;
  return { cols, rows, isSmall: cols < SMALL_SCREEN_THRESHOLD };
};

const store = createStore<TerminalSize>(measure);

process.stdout.on('resize', () => store.set(measure()));

export const terminalSizeStore = {
  ...storeBase(store),
};

export function getClampedTerminalWidth(
  cols: number,
  maxWidth: number,
  gutter = DEFAULT_PANEL_GUTTER,
): number {
  return Math.max(1, Math.min(cols - gutter, maxWidth));
}

export function getResponsivePanelWidth(
  cols: number,
  isSmall: boolean,
  widths: { small: number; large: number } = {
    small: DEFAULT_SMALL_PANEL_WIDTH,
    large: DEFAULT_LARGE_PANEL_WIDTH,
  },
  gutter = DEFAULT_PANEL_GUTTER,
): number {
  return getClampedTerminalWidth(cols, isSmall ? widths.small : widths.large, gutter);
}
