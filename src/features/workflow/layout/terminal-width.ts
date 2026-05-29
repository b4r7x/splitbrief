const DEFAULT_PANEL_GUTTER = 4;
const DEFAULT_SMALL_PANEL_WIDTH = 76;
const DEFAULT_LARGE_PANEL_WIDTH = 110;

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
