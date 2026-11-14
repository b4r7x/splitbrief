import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { Box, useInput } from 'ink';
import {
  type ScrollLineKeyMode,
  type ScrollKeyAction,
  resolveScrollKey,
} from '../../core/keybindings/scroll.js';
import { glyph } from '../../lib/glyphs.js';
import { ScrollIndicator } from '../scroll-indicator.js';
import {
  type ScrollbarColumn,
  hasScrollbarOverflow,
  getScrollViewportContentWidth,
  getScrollbarThumb,
  scrollbarCell,
} from '../scrollbar.js';
import { useTheme, ThemeText as Text } from '../theme.js';
import {
  type ScrollableDocumentRow,
  getScrollableDocumentWindow,
  clampScrollableDocumentOffset,
  rowLineCount,
} from './window.js';

interface ScrollableDocumentProps {
  rows: readonly ScrollableDocumentRow[];
  height: number;
  isActive?: boolean | undefined;
  /** Which arrow keys scroll a line here; a surface sharing them with a composer keeps 'none'. */
  lineKeys?: ScrollLineKeyMode | undefined;
  scrollOffset?: number | undefined;
  onScrollOffsetChange?: ((offset: number) => void) | undefined;
  placeholder?: ReactNode;
  showScrollIndicators?: boolean | undefined;
  showScrollbar?: boolean | undefined;
  width?: number | undefined;
  barColumn?: ScrollbarColumn | undefined;
}

function offsetForScrollAction(args: {
  action: ScrollKeyAction;
  offset: number;
  lineCount: number;
  visibleHeight: number;
}): number {
  const { offset, lineCount, visibleHeight } = args;
  switch (args.action) {
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
  lineKeys = 'none',
  scrollOffset: controlledScrollOffset,
  onScrollOffsetChange,
  placeholder,
  showScrollIndicators = true,
  showScrollbar = false,
  barColumn = 'inside',
  width,
}: ScrollableDocumentProps) {
  const t = useTheme();
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
    const nextOffset = clampScrollableDocumentOffset({
      offset,
      lineCount: windowState.lineCount,
      height: windowState.visibleHeight,
    });
    if (controlledScrollOffset === undefined) setInternalScrollOffset(nextOffset);
    onScrollOffsetChange?.(nextOffset);
  }

  useInput(
    (input, key) => {
      const scrollKey = resolveScrollKey({ input, key, lineKeys });
      if (scrollKey === null) return;
      setRequestedOffset(
        offsetForScrollAction({
          action: scrollKey,
          offset: windowState.offset,
          lineCount: windowState.lineCount,
          visibleHeight: windowState.visibleHeight,
        }),
      );
    },
    { isActive },
  );

  const hasOverflow = hasScrollbarOverflow({
    lineCount: windowState.lineCount,
    visibleHeight: windowState.visibleHeight,
  });
  const showGutter = showScrollbar && hasOverflow;
  // The gutter is paid for only while it paints: a document that fits leaves its rows the whole
  // width, so a section rule inside it ends where the chrome rule above it does.
  const contentWidth =
    showScrollbar && width !== undefined
      ? Math.max(1, showGutter ? getScrollViewportContentWidth(width, barColumn) : width)
      : undefined;
  const thumb = getScrollbarThumb({
    offset: windowState.offset,
    lineCount: windowState.lineCount,
    visibleHeight: windowState.visibleHeight,
  });

  const viewport = (
    <Box
      flexDirection="column"
      height={windowState.visibleHeight}
      width={contentWidth}
      flexShrink={0}
      overflow="hidden"
    >
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
  );

  return (
    <Box flexDirection="column">
      {showScrollIndicators && hasOverflow && (
        <Box height={1} overflow="hidden">
          <ScrollIndicator show={windowState.showScrollUp} direction="up" />
        </Box>
      )}
      {showScrollbar ? (
        <Box
          flexDirection="row"
          height={windowState.visibleHeight}
          width={
            showGutter && barColumn === 'padding' && width !== undefined ? width + 1 : undefined
          }
          overflow="hidden"
        >
          {viewport}
          {showGutter && (
            <Box flexDirection="column" flexShrink={0} marginLeft={1}>
              {Array.from({ length: windowState.visibleHeight }, (_, rowIndex) => {
                const onThumb = scrollbarCell(rowIndex, thumb);
                return (
                  <Text
                    key={`scrollbar-${rowIndex}`}
                    color={onThumb ? t.accent : t.scrollIndicator}
                  >
                    {onThumb ? glyph('scrollThumb') : glyph('scrollTrack')}
                  </Text>
                );
              })}
            </Box>
          )}
        </Box>
      ) : (
        viewport
      )}
      {showScrollIndicators && hasOverflow && (
        <Box height={1} overflow="hidden">
          <ScrollIndicator show={windowState.showScrollDown} direction="down" />
        </Box>
      )}
    </Box>
  );
}
