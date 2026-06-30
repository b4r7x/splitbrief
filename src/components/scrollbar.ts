import { clamp } from '../utils/math.js';

export interface ScrollbarThumb {
  thumbStart: number;
  thumbSize: number;
}

// A proportional vertical scrollbar thumb for a fixed-height viewport. When the content fits, the
// thumb fills the track and callers should simply not render a scrollbar (gate on overflow with
// `lineCount > visibleHeight`).
export function getScrollbarThumb(input: {
  offset: number;
  lineCount: number;
  visibleHeight: number;
}): ScrollbarThumb {
  const { offset, lineCount, visibleHeight } = input;
  if (lineCount <= visibleHeight || visibleHeight <= 0) {
    return { thumbStart: 0, thumbSize: Math.max(0, visibleHeight) };
  }
  const thumbSize = Math.max(1, Math.round((visibleHeight * visibleHeight) / lineCount));
  const maxThumbStart = visibleHeight - thumbSize;
  const clampedOffset = clamp(offset, 0, lineCount - visibleHeight);
  const thumbStart = Math.round((clampedOffset * maxThumbStart) / (lineCount - visibleHeight));
  return { thumbStart, thumbSize };
}

export function scrollbarCell(rowIndex: number, thumb: ScrollbarThumb): boolean {
  return rowIndex >= thumb.thumbStart && rowIndex < thumb.thumbStart + thumb.thumbSize;
}

// Width left for content once the border (2 cells) and the right scrollbar gutter + its pad
// (2 cells) are subtracted from a card's outer width.
export function getScrollViewportContentWidth(outerWidth: number): number {
  return Math.max(0, outerWidth - 4);
}
