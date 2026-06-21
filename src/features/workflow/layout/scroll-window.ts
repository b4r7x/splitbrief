import { clamp } from '../../../utils/math.js';

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

function getReservedScrollBannerRows(
  contentHeight: number,
  visibleHeight: number,
  newEventRows: number,
): number {
  if (contentHeight <= visibleHeight) return 0;
  const contentFloor = contentHeight > 0 ? 1 : 0;
  const rowsAvailable = Math.max(0, visibleHeight - newEventRows - contentFloor);
  return Math.min(2 * TOP_OR_BOTTOM_BANNER_ROWS, rowsAvailable);
}

export function computeScrollMaxOffset(
  totalHeight: number,
  viewportHeight: number,
  hasNewEvents: boolean,
): number {
  const contentHeight = Math.max(0, totalHeight);
  const visibleHeight = Math.max(0, viewportHeight);
  if (contentHeight <= visibleHeight) return 0;

  const newEventRows = hasNewEvents && visibleHeight > 1 ? NEW_EVENT_BANNER_ROWS : 0;
  const scrollBannerRows = getReservedScrollBannerRows(contentHeight, visibleHeight, newEventRows);
  const innerHeight = Math.max(0, visibleHeight - scrollBannerRows - newEventRows);
  return Math.max(0, contentHeight - innerHeight);
}

export interface ScrollWindowStateInput {
  totalHeight: number;
  viewportHeight: number;
  scrollOffset: number;
  hasNewEvents: boolean;
}

export function getScrollWindowState(input: ScrollWindowStateInput): ScrollWindowState {
  const { totalHeight, viewportHeight, scrollOffset, hasNewEvents } = input;
  const contentHeight = Math.max(0, totalHeight);
  const visibleHeight = Math.max(0, viewportHeight);
  const clampedOffset = clamp(
    scrollOffset,
    0,
    computeScrollMaxOffset(contentHeight, visibleHeight, hasNewEvents),
  );
  const newEventRows =
    hasNewEvents && visibleHeight > 1 && clampedOffset > 0 ? NEW_EVENT_BANNER_ROWS : 0;
  const scrollBannerRows = getReservedScrollBannerRows(contentHeight, visibleHeight, newEventRows);
  const bannerRows = scrollBannerRows + newEventRows;
  const innerHeight = Math.max(0, visibleHeight - bannerRows);
  const bottomWindowStart = clamp(contentHeight - innerHeight, 0, contentHeight);
  const windowStart = clamp(bottomWindowStart - clampedOffset, 0, contentHeight);
  const windowEnd = clamp(windowStart + innerHeight, windowStart, contentHeight);
  let showAbove = scrollBannerRows > 0 && windowStart > 0;
  let showBelow = scrollBannerRows > 0 && contentHeight - windowEnd > 0;

  if (scrollBannerRows === TOP_OR_BOTTOM_BANNER_ROWS && showAbove && showBelow) {
    showAbove = windowStart >= contentHeight - windowEnd;
    showBelow = !showAbove;
  }

  return {
    bannerRows,
    innerHeight,
    windowStart,
    windowEnd,
    linesAbove: showAbove ? windowStart : 0,
    linesBelow: showBelow ? Math.max(0, contentHeight - windowEnd) : 0,
    newEventRows,
  };
}
