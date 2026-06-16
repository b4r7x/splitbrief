import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { Box, useInput } from 'ink';
import { ScrollIndicator } from './scroll-indicator.js';

export interface ScrollableDocumentRow {
  key: string;
  node: ReactNode;
  lines?: number | undefined;
}

interface ScrollableDocumentProps {
  rows: ScrollableDocumentRow[];
  height: number;
  isActive?: boolean | undefined;
  keyboardMode?: 'paging' | 'line-and-page' | undefined;
  placeholder?: ReactNode;
}

function rowLineCount(row: ScrollableDocumentRow): number {
  return Math.max(1, row.lines ?? 1);
}

function totalLineCount(rows: ScrollableDocumentRow[]): number {
  return rows.reduce((sum, row) => sum + rowLineCount(row), 0);
}

function clampLineOffset(offset: number, lineCount: number, height: number): number {
  const maxOffset = Math.max(0, lineCount - height);
  return Math.max(0, Math.min(offset, maxOffset));
}

interface VisibleScrollableDocumentRow {
  row: ScrollableDocumentRow;
  skipLines: number;
  visibleLines: number;
}

function sliceRowsByLineOffset(
  rows: ScrollableDocumentRow[],
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

export function ScrollableDocument({
  rows,
  height,
  isActive = true,
  keyboardMode = 'paging',
  placeholder,
}: ScrollableDocumentProps) {
  const visibleHeight = Math.max(1, Math.floor(height));
  const lineCount = totalLineCount(rows);
  const [scrollOffset, setScrollOffset] = useState(0);

  useEffect(() => {
    setScrollOffset((current) => clampLineOffset(current, lineCount, visibleHeight));
  }, [lineCount, visibleHeight]);

  useInput(
    (_input, key) => {
      if (key.home) {
        setScrollOffset(0);
        return;
      }
      if (key.end) {
        setScrollOffset(clampLineOffset(lineCount, lineCount, visibleHeight));
        return;
      }
      if (key.pageUp) {
        setScrollOffset((current) =>
          clampLineOffset(current - visibleHeight, lineCount, visibleHeight),
        );
        return;
      }
      if (key.pageDown) {
        setScrollOffset((current) =>
          clampLineOffset(current + visibleHeight, lineCount, visibleHeight),
        );
        return;
      }
      if (keyboardMode === 'line-and-page' && key.upArrow) {
        setScrollOffset((current) => clampLineOffset(current - 1, lineCount, visibleHeight));
        return;
      }
      if (keyboardMode === 'line-and-page' && key.downArrow) {
        setScrollOffset((current) => clampLineOffset(current + 1, lineCount, visibleHeight));
      }
    },
    { isActive },
  );

  const offset = clampLineOffset(scrollOffset, lineCount, visibleHeight);
  const visibleRows = sliceRowsByLineOffset(rows, offset, visibleHeight);
  const showScrollUp = offset > 0;
  const showScrollDown = offset + visibleHeight < lineCount;

  return (
    <Box flexDirection="column">
      <Box height={1} overflow="hidden">
        <ScrollIndicator show={showScrollUp} direction="up" />
      </Box>
      <Box flexDirection="column" height={visibleHeight} overflow="hidden">
        {visibleRows.map(({ row, skipLines, visibleLines }) => {
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
        <ScrollIndicator show={showScrollDown} direction="down" />
      </Box>
    </Box>
  );
}
