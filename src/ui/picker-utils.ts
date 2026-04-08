export type FilterableItem = { id: string; displayName: string };

export const CURSOR = '\u25B8 ';
export const NO_CURSOR = '  ';

export function computeScrollOffset(index: number, windowSize: number, totalItems: number): number {
  if (totalItems <= windowSize) return 0;
  const half = Math.floor(windowSize / 2);
  return Math.max(0, Math.min(index - half, totalItems - windowSize));
}

export function filterByFields<T>(item: T, query: string, fields: (keyof T)[]): boolean {
  const lower = query.toLowerCase();
  return fields.some(f => String(item[f]).toLowerCase().includes(lower));
}

export function maxVisibleRows(terminalRows: number, chromeRows: number, min = 3): number {
  return Math.max(terminalRows - chromeRows, min);
}

export function computeScrollWindow<T>(
  items: T[],
  selectedIndex: number,
  terminalRows: number,
  chromeRows: number,
  minVisible?: number,
) {
  const maxVisible = maxVisibleRows(terminalRows, chromeRows, minVisible);
  const scrollOffset = computeScrollOffset(selectedIndex, maxVisible, items.length);
  const visibleSlice = items.slice(scrollOffset, scrollOffset + maxVisible);
  const showScrollUp = scrollOffset > 0;
  const showScrollDown = scrollOffset + maxVisible < items.length;
  return { maxVisible, scrollOffset, visibleSlice, showScrollUp, showScrollDown };
}
