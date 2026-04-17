import { availableRows } from '../../core/layout/picker-chrome.js';

export type FilterableItem = { id: string; displayName: string };

export const CURSOR = '\u25B8 ';
export const NO_CURSOR = '  ';

export function computeScrollOffset(index: number, windowSize: number, totalItems: number): number {
  if (totalItems <= windowSize) return 0;
  const half = Math.floor(windowSize / 2);
  return Math.max(0, Math.min(index - half, totalItems - windowSize));
}

export function filterByFields<T>(item: T, query: string, fields: (keyof T)[]): boolean {
  if (query.length === 0) return true;
  const lower = query.toLowerCase();
  for (const f of fields) {
    if (String(item[f]).toLowerCase().includes(lower)) return true;
  }
  return false;
}

export function computeScrollWindow<T>(
  items: T[],
  selectedIndex: number,
  terminalRows: number,
  chromeRows: number,
  maxVisible?: number,
) {
  const visible = availableRows(terminalRows, chromeRows, maxVisible);
  const scrollOffset = computeScrollOffset(selectedIndex, visible, items.length);
  const visibleSlice = items.slice(scrollOffset, scrollOffset + visible);
  const showScrollUp = scrollOffset > 0;
  const showScrollDown = scrollOffset + visible < items.length;
  return { maxVisible: visible, scrollOffset, visibleSlice, showScrollUp, showScrollDown };
}
