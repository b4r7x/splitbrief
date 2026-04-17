export function availableRows(rows: number, chrome: number, floor = 3): number {
  return Math.max(rows - chrome, floor);
}
