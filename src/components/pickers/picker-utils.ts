export type FilterableItem = { id: string; displayName: string };

export function availableRows(rows: number, chrome: number, floor = 3): number {
  return Math.max(rows - chrome, floor);
}

export const CURSOR = '\u25B8 ';
export const NO_CURSOR = '  ';

export function computeScrollOffset(opts: {
  index: number;
  windowSize: number;
  totalItems: number;
}): number {
  const { index, windowSize, totalItems } = opts;
  if (totalItems <= windowSize) return 0;
  const half = Math.floor(windowSize / 2);
  return Math.max(0, Math.min(index - half, totalItems - windowSize));
}

export function rotateIndex(current: number, length: number, delta: 1 | -1): number {
  return (current + delta + length) % length;
}

export function windowSlice<T>(items: T[], selectedIndex: number, windowSize: number) {
  const scrollOffset = computeScrollOffset({
    index: selectedIndex,
    windowSize,
    totalItems: items.length,
  });
  return {
    scrollOffset,
    visibleSlice: items.slice(scrollOffset, scrollOffset + windowSize),
    showScrollUp: scrollOffset > 0,
    showScrollDown: scrollOffset + windowSize < items.length,
  };
}

export function filterByFields<T>(item: T, query: string, fields: (keyof T)[]): boolean {
  if (query.length === 0) return true;
  const lower = query.toLowerCase();
  for (const f of fields) {
    if (String(item[f]).toLowerCase().includes(lower)) return true;
  }
  return false;
}

export function computeScrollWindow<T>(opts: {
  items: T[];
  selectedIndex: number;
  terminalRows: number;
  chromeRows: number;
  maxVisible?: number | undefined;
}) {
  const { items, selectedIndex, terminalRows, chromeRows, maxVisible } = opts;
  const base = availableRows(terminalRows, chromeRows);
  const visible = maxVisible !== undefined ? Math.min(base, maxVisible) : base;
  const scrollOffset = computeScrollOffset({
    index: selectedIndex,
    windowSize: visible,
    totalItems: items.length,
  });
  const visibleSlice = items.slice(scrollOffset, scrollOffset + visible);
  const showScrollUp = scrollOffset > 0;
  const showScrollDown = scrollOffset + visible < items.length;
  return { maxVisible: visible, scrollOffset, visibleSlice, showScrollUp, showScrollDown };
}
