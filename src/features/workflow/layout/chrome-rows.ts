// Header (1) + meta row (1) + AgentStatusRow (1) = 3 rows.
export const TOP_FIXED_CHROME_ROWS = 3;
// ConfigLine is optional and tracked separately from the fixed top chrome.
export const CONFIG_CHROME_ROWS = 1;
// Footer divider (1) + feedback row (1) + composer + input footer rows.
export const BOTTOM_FOOTER_DIVIDER_ROWS = 1;
export const BOTTOM_FIXED_CHROME_ROWS = 2 + BOTTOM_FOOTER_DIVIDER_ROWS;
export const INLINE_CONFIG_MIN_COLS = 88;

export function getChromeContentWidth(cols: number): number {
  return Math.max(1, cols - 2);
}

export function getConfigChromeRows(hasConfig: boolean, cols?: number): number {
  if (!hasConfig) return 0;
  if (cols !== undefined && cols >= INLINE_CONFIG_MIN_COLS) return 0;
  return CONFIG_CHROME_ROWS;
}

export function getChromeHeight(inputRows: number, hasConfig: boolean, cols?: number): number {
  const configRows = getConfigChromeRows(hasConfig, cols);
  return TOP_FIXED_CHROME_ROWS + configRows + BOTTOM_FIXED_CHROME_ROWS + inputRows;
}

export function getContentTopRow(hasConfig: boolean, cols?: number): number {
  return TOP_FIXED_CHROME_ROWS + getConfigChromeRows(hasConfig, cols) + 1;
}
