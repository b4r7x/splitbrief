import { clamp } from './math.js';

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
  const overflow = Math.max(0, Math.max(0, totalHeight) - Math.max(0, viewportHeight));
  if (overflow === 0) return 0;
  return overflow + TOP_OR_BOTTOM_BANNER_ROWS + (hasNewEvents ? NEW_EVENT_BANNER_ROWS : 0);
}

export function getScrollWindowState(
  totalHeight: number,
  viewportHeight: number,
  scrollOffset: number,
  hasNewEvents: boolean,
): ScrollWindowState {
  const contentHeight = Math.max(0, totalHeight);
  const visibleHeight = Math.max(0, viewportHeight);
  const clampedOffset = clamp(
    scrollOffset,
    0,
    computeScrollMaxOffset(contentHeight, visibleHeight, hasNewEvents),
  );
  const newEventRows = hasNewEvents && clampedOffset > 0 ? NEW_EVENT_BANNER_ROWS : 0;

  const firstInner = Math.max(0, visibleHeight - newEventRows);
  const firstStart = clamp(contentHeight - firstInner - clampedOffset, 0, contentHeight);
  const firstEnd = clamp(firstStart + firstInner, firstStart, contentHeight);
  const needsAbove = firstStart > 0;
  const needsBelow = contentHeight - firstEnd > 0;

  const bannerRows =
    (needsAbove ? TOP_OR_BOTTOM_BANNER_ROWS : 0) +
    (needsBelow ? TOP_OR_BOTTOM_BANNER_ROWS : 0) +
    newEventRows;

  const innerHeight = Math.max(0, visibleHeight - bannerRows);
  const windowStart = clamp(contentHeight - innerHeight - clampedOffset, 0, contentHeight);
  const windowEnd = clamp(windowStart + innerHeight, windowStart, contentHeight);

  return {
    bannerRows,
    innerHeight,
    windowStart,
    windowEnd,
    linesAbove: windowStart,
    linesBelow: Math.max(0, contentHeight - windowEnd),
    newEventRows,
  };
}
