import type { ReactNode } from 'react';
import { clamp } from '../../utils/math.js';

export interface ScrollableDocumentRow {
  key: string;
  node: ReactNode;
  lines?: number | undefined;
}

export function rowLineCount(row: ScrollableDocumentRow): number {
  return Math.max(1, row.lines ?? 1);
}

export function getScrollableDocumentLineCount(rows: readonly ScrollableDocumentRow[]): number {
  return rows.reduce((sum, row) => sum + rowLineCount(row), 0);
}

function normalizeVisibleHeight(height: number): number {
  return Math.max(1, Math.floor(height));
}

export function clampScrollableDocumentOffset(args: {
  offset: number;
  lineCount: number;
  height: number;
}): number {
  const maxOffset = Math.max(0, args.lineCount - normalizeVisibleHeight(args.height));
  return clamp(Math.floor(args.offset), 0, maxOffset);
}

interface VisibleScrollableDocumentRow {
  row: ScrollableDocumentRow;
  skipLines: number;
  visibleLines: number;
}

function sliceRowsByLineOffset(
  rows: readonly ScrollableDocumentRow[],
  lineOffset: number,
  visibleHeight: number,
): VisibleScrollableDocumentRow[] {
  const visible: VisibleScrollableDocumentRow[] = [];
  let cursor = 0;
  for (const row of rows) {
    const lines = rowLineCount(row);
    const rowEnd = cursor + lines;
    if (rowEnd <= lineOffset) {
      cursor = rowEnd;
      continue;
    }
    if (cursor >= lineOffset + visibleHeight) break;
    const visibleStart = Math.max(cursor, lineOffset);
    const visibleEnd = Math.min(rowEnd, lineOffset + visibleHeight);
    visible.push({
      row,
      skipLines: visibleStart - cursor,
      visibleLines: visibleEnd - visibleStart,
    });
    cursor = rowEnd;
  }
  return visible;
}

interface ScrollableDocumentWindow {
  lineCount: number;
  offset: number;
  visibleHeight: number;
  visibleRows: VisibleScrollableDocumentRow[];
  showScrollUp: boolean;
  showScrollDown: boolean;
}

export function getScrollableDocumentWindow(
  rows: readonly ScrollableDocumentRow[],
  requestedOffset: number,
  height: number,
): ScrollableDocumentWindow {
  const visibleHeight = normalizeVisibleHeight(height);
  const lineCount = getScrollableDocumentLineCount(rows);
  const offset = clampScrollableDocumentOffset({
    offset: requestedOffset,
    lineCount,
    height: visibleHeight,
  });
  return {
    lineCount,
    offset,
    visibleHeight,
    visibleRows: sliceRowsByLineOffset(rows, offset, visibleHeight),
    showScrollUp: offset > 0,
    showScrollDown: offset + visibleHeight < lineCount,
  };
}
