import { clamp } from '../utils/math.js';

function normalizeCount(value: number): number {
  return Math.max(0, Math.floor(value));
}

export interface ScrollbarThumb {
  thumbStart: number;
  thumbSize: number;
}

interface ScrollbarInput {
  offset: number;
  lineCount: number;
  visibleHeight: number;
}

export function hasScrollbarOverflow(
  input: Pick<ScrollbarInput, 'lineCount' | 'visibleHeight'>,
): boolean {
  const lineCount = normalizeCount(input.lineCount);
  const visibleHeight = normalizeCount(input.visibleHeight);
  return visibleHeight > 0 && lineCount > visibleHeight;
}

export function getScrollbarThumb(input: ScrollbarInput): ScrollbarThumb {
  const lineCount = normalizeCount(input.lineCount);
  const visibleHeight = normalizeCount(input.visibleHeight);
  if (!hasScrollbarOverflow({ lineCount, visibleHeight })) {
    return { thumbStart: 0, thumbSize: visibleHeight };
  }
  const thumbSize = Math.max(1, Math.round((visibleHeight * visibleHeight) / lineCount));
  const maxThumbStart = visibleHeight - thumbSize;
  const clampedOffset = clamp(Math.floor(input.offset), 0, lineCount - visibleHeight);
  const thumbStart = Math.round((clampedOffset * maxThumbStart) / (lineCount - visibleHeight));
  return { thumbStart, thumbSize };
}

export function scrollbarCell(rowIndex: number, thumb: ScrollbarThumb): boolean {
  return rowIndex >= thumb.thumbStart && rowIndex < thumb.thumbStart + thumb.thumbSize;
}

/** A scroll gutter is one blank separator column plus the one-cell bar. */
const SCROLL_GUTTER_CELLS = 2;

/**
 * Where the bar column sits. `inside` keeps the whole gutter within the width;
 * `padding` draws the bar one cell past it, in a frame's padding column, so it
 * stands one cell off the border exactly like the composer dropdown's bar.
 */
export type ScrollbarColumn = 'inside' | 'padding';

export function getScrollViewportContentWidth(
  outerWidth: number,
  barColumn: ScrollbarColumn = 'inside',
): number {
  const gutter = barColumn === 'padding' ? SCROLL_GUTTER_CELLS - 1 : SCROLL_GUTTER_CELLS;
  return Math.max(0, normalizeCount(outerWidth) - gutter);
}
