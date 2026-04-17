export const MAX_DIFF_ROWS_RATIO = 0.5;
export const MIN_MAX_DIFF_ROWS = 10;

export function getMaxVisibleDiffLines(rows: number): number {
  return Math.max(MIN_MAX_DIFF_ROWS, Math.floor(rows * MAX_DIFF_ROWS_RATIO));
}
