const DEFAULT_PANEL_GUTTER = 4;
const DEFAULT_SMALL_PANEL_WIDTH = 76;
const DEFAULT_LARGE_PANEL_WIDTH = 110;

export function getClampedTerminalWidth(opts: {
  cols: number;
  maxWidth: number;
  gutter?: number;
}): number {
  const { cols, maxWidth, gutter = DEFAULT_PANEL_GUTTER } = opts;
  return Math.max(1, Math.min(cols - gutter, maxWidth));
}

export function getResponsivePanelWidth(opts: {
  cols: number;
  size: 'small' | 'large';
  widths?: { small: number; large: number };
  gutter?: number;
}): number {
  const {
    cols,
    size,
    widths = { small: DEFAULT_SMALL_PANEL_WIDTH, large: DEFAULT_LARGE_PANEL_WIDTH },
    gutter = DEFAULT_PANEL_GUTTER,
  } = opts;
  return getClampedTerminalWidth({
    cols,
    maxWidth: size === 'small' ? widths.small : widths.large,
    gutter,
  });
}
