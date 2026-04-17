export function computeViewportScroll(params: {
  previous: number;
  markerHeight: number;
  visibleRows: number;
  contentHeight: number;
}): number {
  const { previous, markerHeight, visibleRows, contentHeight } = params;
  const cursorLineEnd = markerHeight;
  const viewportStart = previous;
  const viewportEnd = previous + visibleRows;
  if (cursorLineEnd <= viewportStart) {
    return Math.max(0, cursorLineEnd - 1);
  }
  if (cursorLineEnd > viewportEnd) {
    return cursorLineEnd - visibleRows;
  }
  if (contentHeight) {
    if (contentHeight < visibleRows) {
      return 0;
    }
    if (contentHeight < viewportEnd) {
      return contentHeight - visibleRows;
    }
  }
  return previous;
}
