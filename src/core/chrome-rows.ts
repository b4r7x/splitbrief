/** Fixed rows before the scrollable content: header (1) + agent status (1) + spacer (1) = 3 */
export const TOP_FIXED_CHROME_ROWS = 3;
/** Optional rows before the scrollable content when workflow config is shown. */
export const CONFIG_CHROME_ROWS = 2;
/** Fixed rows after the scrollable content: feedback (1) + footer (1) = 2 */
export const BOTTOM_FIXED_CHROME_ROWS = 2;

export function getChromeHeight(inputRows: number, hasConfig: boolean): number {
  const configRows = hasConfig ? CONFIG_CHROME_ROWS : 0;
  return TOP_FIXED_CHROME_ROWS + configRows + BOTTOM_FIXED_CHROME_ROWS + inputRows;
}

export function getContentTopRow(hasConfig: boolean): number {
  return TOP_FIXED_CHROME_ROWS + (hasConfig ? CONFIG_CHROME_ROWS : 0) + 1;
}
