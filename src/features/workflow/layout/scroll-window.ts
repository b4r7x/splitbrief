import { clamp } from '../../../utils/math.js';

/**
 * Workflow dimensions are terminal rows. Normalizing them at this boundary keeps the window
 * arithmetic integer-valued even while a terminal resize is settling, and turns invalid sizes
 * into the same empty-body geometry used by the renderers.
 */
export function normalizeScrollRows(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

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
  const contentHeight = normalizeScrollRows(input.totalHeight);
  const visibleHeight = normalizeScrollRows(input.viewportHeight);
  return Math.max(0, contentHeight - visibleHeight);
}

export interface ScrollWindowStateInput {
  totalHeight: number;
  /** The already-clipped T-077 body height; no sidebar or chrome rows belong here. */
  viewportHeight: number;
  scrollOffset: number;
}

export function getScrollWindowState(input: ScrollWindowStateInput): ScrollWindowState {
  const contentHeight = normalizeScrollRows(input.totalHeight);
  const visibleHeight = normalizeScrollRows(input.viewportHeight);
  const clampedOffset = clamp(
    Number.isFinite(input.scrollOffset) ? Math.floor(input.scrollOffset) : 0,
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
