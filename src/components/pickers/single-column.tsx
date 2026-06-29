import type { ReactNode } from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../theme.js';
import { borderStyleFor, glyph } from '../../lib/glyphs.js';
import { getScrollbarThumb, scrollbarCell } from '../scrollbar.js';
import { windowSlice } from './scroll-window.js';
import { CursorCell } from './cursor-cell.js';
import { RowZone, ROW_ZONE_Z_OVERLAY } from './row-zone.js';

const CURSOR_WIDTH = 2;

interface SingleColumnPickerProps<T> {
  label: string;
  items: T[];
  filter: string;
  selectedIndex: number;
  isActive: boolean;
  height: number;
  visibleRows: number;
  getKey: (item: T) => string;
  renderRow: (item: T, isCursor: boolean, maxWidth: number) => ReactNode;
  contentMaxWidth: number;
  placeholderWhenEmpty?: ReactNode;
  hideFilterRow?: boolean;
  customFilterPrompt?: ReactNode;
  emptyText?: string;
  onRowActivate?: ((globalIndex: number) => void) | undefined;
  rowZonePrefix?: string | undefined;
  rowZoneZ?: number | undefined;
}

export function SingleColumnPicker<T>({
  label,
  items,
  filter,
  selectedIndex,
  isActive,
  height,
  visibleRows,
  getKey,
  renderRow,
  contentMaxWidth,
  placeholderWhenEmpty,
  hideFilterRow,
  customFilterPrompt,
  emptyText = 'no items',
  onRowActivate,
  rowZonePrefix = 'single-column-row',
  rowZoneZ = ROW_ZONE_Z_OVERLAY,
}: SingleColumnPickerProps<T>) {
  const t = useTheme();

  const {
    scrollOffset,
    visibleSlice: slice,
    showScrollUp,
    showScrollDown,
  } = windowSlice({ items, selectedIndex, windowSize: visibleRows });

  const overflow = showScrollUp || showScrollDown;
  const thumb = getScrollbarThumb({
    offset: scrollOffset,
    lineCount: items.length,
    visibleHeight: slice.length,
  });
  const rowContentWidth = Math.max(1, contentMaxWidth - CURSOR_WIDTH - (overflow ? 1 : 0));

  return (
    <Box
      flexDirection="column"
      flexGrow={1}
      flexBasis={0}
      height={height}
      borderStyle={borderStyleFor('round')}
      borderColor={isActive ? t.accent : t.border}
      borderDimColor={!isActive}
      paddingX={1}
    >
      <Text color={isActive ? t.accent : t.textDim}>{label}</Text>

      {!hideFilterRow && (
        <Box>
          <Text color={isActive ? t.accent : t.textDim}>{`${glyph('prompt')} `}</Text>
          {customFilterPrompt ??
            (filter ? (
              <Text color={t.text}>{filter}</Text>
            ) : (
              <Text color={t.textDim}>type to filter…</Text>
            ))}
        </Box>
      )}

      {items.length === 0
        ? (placeholderWhenEmpty ?? <Text color={t.textDim}>{emptyText}</Text>)
        : slice.map((item, i) => {
            const idx = scrollOffset + i;
            const isCursor = isActive && idx === selectedIndex;
            const onThumb = scrollbarCell(i, thumb);
            const rowNode = (
              <Box key={getKey(item)}>
                <CursorCell isCursor={isCursor} dimWhenInactive />
                <Box flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">
                  {renderRow(item, isCursor, rowContentWidth)}
                </Box>
                {overflow ? (
                  <Text color={onThumb ? t.accent : t.scrollIndicator}>
                    {onThumb ? glyph('scrollThumb') : glyph('scrollTrack')}
                  </Text>
                ) : null}
              </Box>
            );
            return onRowActivate ? (
              <RowZone
                key={getKey(item)}
                zoneId={`${rowZonePrefix}:${getKey(item)}`}
                z={rowZoneZ}
                onActivate={() => onRowActivate(idx)}
              >
                {rowNode}
              </RowZone>
            ) : (
              rowNode
            );
          })}
    </Box>
  );
}
