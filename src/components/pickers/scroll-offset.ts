import { clamp } from '../../utils/math.js';

export function normalizeCount(value: number): number {
  return Math.max(0, Math.floor(value));
}

export function availableRows(opts: {
  rows: number;
  chromeRows: number;
  floor?: number | undefined;
}): number {
  return Math.max(
    normalizeCount(opts.rows) - normalizeCount(opts.chromeRows),
    normalizeCount(opts.floor ?? 0),
  );
}

/** The key legend takes one row. A list gets the rest of its panel after its header and details. */
export function overlayListRows(bodyRows: number, headerRows: number, detailRows = 0): number {
  return availableRows({ rows: bodyRows, chromeRows: headerRows + detailRows + 1 });
}

export function computeScrollOffset(opts: {
  index: number;
  windowSize: number;
  totalItems: number;
}): number {
  const totalItems = normalizeCount(opts.totalItems);
  const windowSize = normalizeCount(opts.windowSize);
  if (windowSize === 0) return 0;
  if (totalItems <= windowSize) return 0;
  const half = Math.floor(windowSize / 2);
  return Math.max(0, Math.min(Math.floor(opts.index) - half, totalItems - windowSize));
}

// A cursor-following window: the offset holds while the index is inside it and moves by the least
// that brings the index back in, so the cursor walks to the edge before the list slides.
export function keepInViewOffset(opts: {
  previous: number;
  index: number;
  windowSize: number;
  totalItems: number;
}): number {
  const totalItems = normalizeCount(opts.totalItems);
  const windowSize = normalizeCount(opts.windowSize);
  if (windowSize === 0 || totalItems <= windowSize) return 0;
  const index = clamp(Math.floor(opts.index), 0, totalItems - 1);
  const offset = clamp(normalizeCount(opts.previous), index - windowSize + 1, index);
  return clamp(offset, 0, totalItems - windowSize);
}

export function windowSlice<T>(opts: { items: T[]; selectedIndex: number; windowSize: number }) {
  const { items, selectedIndex } = opts;
  const windowSize = normalizeCount(opts.windowSize);
  if (windowSize === 0) {
    return {
      scrollOffset: 0,
      visibleSlice: [],
      showScrollUp: false,
      showScrollDown: false,
    };
  }
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
