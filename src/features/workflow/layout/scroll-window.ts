import { clamp } from '../../../utils/math.js';

export interface ScrollWindowState {
  innerHeight: number;
  windowStart: number;
  windowEnd: number;
  linesAbove: number;
  linesBelow: number;
}

// Scroll banners ride the chrome dividers (header label above, footer label below), so the
// transcript window owns every viewport row and reserves nothing for in-flow banners.
export function computeScrollMaxOffset(input: {
  totalHeight: number;
  viewportHeight: number;
}): number {
  const { totalHeight, viewportHeight } = input;
  const contentHeight = Math.max(0, totalHeight);
  const visibleHeight = Math.max(0, viewportHeight);
  return Math.max(0, contentHeight - visibleHeight);
}

export interface ScrollWindowStateInput {
  totalHeight: number;
  viewportHeight: number;
  scrollOffset: number;
}

export function getScrollWindowState(input: ScrollWindowStateInput): ScrollWindowState {
  const contentHeight = Math.max(0, input.totalHeight);
  const visibleHeight = Math.max(0, input.viewportHeight);
  const clampedOffset = clamp(
    input.scrollOffset,
    0,
    computeScrollMaxOffset({ totalHeight: contentHeight, viewportHeight: visibleHeight }),
  );
  const bottomWindowStart = clamp(contentHeight - visibleHeight, 0, contentHeight);
  const windowStart = clamp(bottomWindowStart - clampedOffset, 0, contentHeight);
  const windowEnd = clamp(windowStart + visibleHeight, windowStart, contentHeight);

  return {
    innerHeight: visibleHeight,
    windowStart,
    windowEnd,
    linesAbove: windowStart,
    linesBelow: Math.max(0, contentHeight - windowEnd),
  };
}
