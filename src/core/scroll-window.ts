export interface ScrollWindowState {
  bannerRows: number;
  innerHeight: number;
  windowStart: number;
  windowEnd: number;
  linesAbove: number;
  linesBelow: number;
  newEventRows: number;
}

const TOP_OR_BOTTOM_BANNER_ROWS = 1;
const NEW_EVENT_BANNER_ROWS = 1;

export function computeScrollMaxOffset(
  totalHeight: number,
  viewportHeight: number,
  hasNewEvents: boolean,
): number {
  const overflow = Math.max(0, totalHeight - viewportHeight);
  if (overflow === 0) return 0;
  return overflow + TOP_OR_BOTTOM_BANNER_ROWS + (hasNewEvents ? NEW_EVENT_BANNER_ROWS : 0);
}

export function getScrollWindowState(
  totalHeight: number,
  viewportHeight: number,
  scrollOffset: number,
  hasNewEvents: boolean,
): ScrollWindowState {
  const newEventRows = hasNewEvents && scrollOffset > 0 ? NEW_EVENT_BANNER_ROWS : 0;

  // First pass: compute window without top/bottom banners to determine which are needed.
  const firstInner = Math.max(0, viewportHeight - newEventRows);
  const firstStart = Math.max(0, totalHeight - firstInner - scrollOffset);
  const firstEnd = Math.min(totalHeight, firstStart + firstInner);
  const needsAbove = firstStart > 0;
  const needsBelow = totalHeight - firstEnd > 0;

  // Derive final bannerRows analytically from the two booleans.
  const bannerRows =
    (needsAbove ? TOP_OR_BOTTOM_BANNER_ROWS : 0) +
    (needsBelow ? TOP_OR_BOTTOM_BANNER_ROWS : 0) +
    newEventRows;

  // Final pass: recompute window with correct bannerRows.
  const innerHeight = Math.max(0, viewportHeight - bannerRows);
  const windowStart = Math.max(0, totalHeight - innerHeight - scrollOffset);
  const windowEnd = Math.min(totalHeight, windowStart + innerHeight);

  return {
    bannerRows,
    innerHeight,
    windowStart,
    windowEnd,
    linesAbove: windowStart,
    linesBelow: Math.max(0, totalHeight - windowEnd),
    newEventRows,
  };
}
