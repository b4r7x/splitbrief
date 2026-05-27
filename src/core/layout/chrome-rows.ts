// Header (1) + AgentStatusRow (1) + CostStatusLine (1) + spacer (1) = 4 rows.
export const TOP_FIXED_CHROME_ROWS = 4;
export const CONFIG_CHROME_ROWS = 4;
export const BOTTOM_FIXED_CHROME_ROWS = 2;

export function getChromeHeight(inputRows: number, hasConfig: boolean): number {
  const configRows = hasConfig ? CONFIG_CHROME_ROWS : 0;
  return TOP_FIXED_CHROME_ROWS + configRows + BOTTOM_FIXED_CHROME_ROWS + inputRows;
}

export function getContentTopRow(hasConfig: boolean): number {
  return TOP_FIXED_CHROME_ROWS + (hasConfig ? CONFIG_CHROME_ROWS : 0) + 1;
}
