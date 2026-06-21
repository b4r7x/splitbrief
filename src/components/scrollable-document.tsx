import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { Box, useInput } from 'ink';
import { resolveScrollKey, type ScrollKeyAction } from '../core/keybindings/scroll.js';
import { ScrollIndicator } from './scroll-indicator.js';

export interface ScrollableDocumentRow {
  key: string;
  node: ReactNode;
  lines?: number | undefined;
}

interface ScrollableDocumentProps {
  rows: readonly ScrollableDocumentRow[];
  height: number;
  isActive?: boolean | undefined;
  keyboardMode?: 'paging' | 'line-and-page' | undefined;
  scrollOffset?: number | undefined;
  onScrollOffsetChange?: ((offset: number) => void) | undefined;
  placeholder?: ReactNode;
}

function rowLineCount(row: ScrollableDocumentRow): number {
  return Math.max(1, row.lines ?? 1);
}

export function getScrollableDocumentLineCount(rows: readonly ScrollableDocumentRow[]): number {
  return rows.reduce((sum, row) => sum + rowLineCount(row), 0);
}

function normalizeVisibleHeight(height: number): number {
  return Math.max(1, Math.floor(height));
}

export function clampScrollableDocumentOffset(
  offset: number,
  lineCount: number,
  height: number,
): number {
  const maxOffset = Math.max(0, lineCount - normalizeVisibleHeight(height));
  return Math.max(0, Math.min(Math.floor(offset), maxOffset));
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

function getScrollableDocumentWindow(
  rows: readonly ScrollableDocumentRow[],
  requestedOffset: number,
  height: number,
): ScrollableDocumentWindow {
  const visibleHeight = normalizeVisibleHeight(height);
  const lineCount = getScrollableDocumentLineCount(rows);
  const offset = clampScrollableDocumentOffset(requestedOffset, lineCount, visibleHeight);
  return {
    lineCount,
    offset,
    visibleHeight,
    visibleRows: sliceRowsByLineOffset(rows, offset, visibleHeight),
    showScrollUp: offset > 0,
    showScrollDown: offset + visibleHeight < lineCount,
  };
}

function offsetForScrollAction(
  action: ScrollKeyAction,
  offset: number,
  lineCount: number,
  visibleHeight: number,
): number {
  switch (action) {
    case 'line-up':
      return offset - 1;
    case 'line-down':
      return offset + 1;
    case 'page-up':
      return offset - visibleHeight;
    case 'page-down':
      return offset + visibleHeight;
    case 'top':
      return 0;
    case 'bottom':
      return lineCount;
  }
}

export function ScrollableDocument({
  rows,
  height,
  isActive = true,
  keyboardMode = 'paging',
  scrollOffset: controlledScrollOffset,
  onScrollOffsetChange,
  placeholder,
}: ScrollableDocumentProps) {
  const [internalScrollOffset, setInternalScrollOffset] = useState(0);
  const requestedOffset = controlledScrollOffset ?? internalScrollOffset;
  const windowState = getScrollableDocumentWindow(rows, requestedOffset, height);

  useEffect(() => {
    if (controlledScrollOffset !== undefined) {
      if (controlledScrollOffset !== windowState.offset) onScrollOffsetChange?.(windowState.offset);
      return;
    }
    if (internalScrollOffset !== windowState.offset) setInternalScrollOffset(windowState.offset);
  }, [controlledScrollOffset, internalScrollOffset, windowState.offset, onScrollOffsetChange]);

  function setRequestedOffset(offset: number) {
    const nextOffset = clampScrollableDocumentOffset(
      offset,
      windowState.lineCount,
      windowState.visibleHeight,
    );
    if (controlledScrollOffset === undefined) setInternalScrollOffset(nextOffset);
    onScrollOffsetChange?.(nextOffset);
  }

  useInput(
    (input, key) => {
      const scrollKey = resolveScrollKey({
        input,
        key,
        lineKeys: keyboardMode === 'line-and-page' ? 'plain' : 'none',
      });
      if (scrollKey === null) return;
      setRequestedOffset(
        offsetForScrollAction(
          scrollKey,
          windowState.offset,
          windowState.lineCount,
          windowState.visibleHeight,
        ),
      );
    },
    { isActive },
  );

  return (
    <Box flexDirection="column">
      <Box height={1} overflow="hidden">
        <ScrollIndicator show={windowState.showScrollUp} direction="up" />
      </Box>
      <Box flexDirection="column" height={windowState.visibleHeight} overflow="hidden">
        {windowState.visibleRows.map(({ row, skipLines, visibleLines }) => {
          const lines = rowLineCount(row);
          if (skipLines === 0 && visibleLines === lines && lines === 1) {
            return <Box key={row.key}>{row.node}</Box>;
          }
          return (
            <Box key={row.key} flexDirection="column" height={visibleLines} overflow="hidden">
              <Box marginTop={-skipLines} flexShrink={0}>
                {row.node}
              </Box>
            </Box>
          );
        })}
        {rows.length === 0 && placeholder}
      </Box>
      <Box height={1} overflow="hidden">
        <ScrollIndicator show={windowState.showScrollDown} direction="down" />
      </Box>
    </Box>
  );
}
