import type { ReactNode } from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../theme.js';
import { borderStyleFor, glyph } from '../../lib/glyphs.js';
import { getScrollbarThumb, hasScrollbarOverflow, scrollbarCell } from '../scrollbar.js';
import { windowSlice } from './scroll-window.js';
import { RowZone, ROW_ZONE_Z_OVERLAY } from './row-zone.js';

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

function ScrollbarGutter({ onThumb, color }: { onThumb: boolean; color: string }) {
  return (
    <Box marginLeft={1}>
      <Text color={color}>{onThumb ? glyph('scrollThumb') : glyph('scrollTrack')}</Text>
    </Box>
  );
}

function FilterRow({
  filter,
  isActive,
  customFilterPrompt,
}: Pick<SingleColumnPickerProps<unknown>, 'filter' | 'isActive' | 'customFilterPrompt'>) {
  const t = useTheme();
  let prompt: ReactNode;
  if (customFilterPrompt !== undefined && customFilterPrompt !== null) {
    prompt = customFilterPrompt;
  } else if (filter) {
    prompt = <Text color={t.text}>{filter}</Text>;
  } else {
    prompt = <Text color={t.textDim}>Type to filter…</Text>;
  }

  return (
    <Box>
      <Text color={isActive ? t.accent : t.textDim}>{`${glyph('prompt')} `}</Text>
      {prompt}
    </Box>
  );
}

function FillerRows({ count, color }: { count: number; color: string }) {
  return Array.from({ length: count }, (_, index) => (
    <Box key={`scrollbar-filler-${index}`}>
      <Box flexGrow={1} />
      <ScrollbarGutter onThumb={false} color={color} />
    </Box>
  ));
}

type PickerRowsProps<T> = Pick<
  SingleColumnPickerProps<T>,
  | 'items'
  | 'selectedIndex'
  | 'isActive'
  | 'visibleRows'
  | 'getKey'
  | 'renderRow'
  | 'contentMaxWidth'
  | 'placeholderWhenEmpty'
  | 'onRowActivate'
> & {
  emptyText: string;
  rowZonePrefix: string;
  rowZoneZ: number;
};

function PickerRows<T>({
  items,
  selectedIndex,
  isActive,
  visibleRows,
  getKey,
  renderRow,
  contentMaxWidth,
  placeholderWhenEmpty,
  emptyText,
  onRowActivate,
  rowZonePrefix,
  rowZoneZ,
}: PickerRowsProps<T>) {
  const t = useTheme();
  if (items.length === 0) {
    if (visibleRows <= 0) return null;
    return (
      <>
        <Box>
          <Box flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">
            {placeholderWhenEmpty ?? <Text color={t.textDim}>{emptyText}</Text>}
          </Box>
          <ScrollbarGutter onThumb={false} color={t.scrollIndicator} />
        </Box>
        <FillerRows count={visibleRows - 1} color={t.scrollIndicator} />
      </>
    );
  }

  const { scrollOffset, visibleSlice } = windowSlice({
    items,
    selectedIndex,
    windowSize: visibleRows,
  });
  const overflow = hasScrollbarOverflow({
    lineCount: items.length,
    visibleHeight: visibleRows,
  });
  const thumb = getScrollbarThumb({
    offset: scrollOffset,
    lineCount: items.length,
    visibleHeight: visibleRows,
  });
  const rowContentWidth = contentMaxWidth - 2;

  return (
    <>
      {visibleSlice.map((item, index) => {
        const itemIndex = scrollOffset + index;
        const itemKey = getKey(item);
        const isCursor = isActive && itemIndex === selectedIndex;
        const rowNode = (
          <Box key={itemKey} width="100%">
            <Box flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">
              {renderRow(item, isCursor, rowContentWidth)}
            </Box>
            <ScrollbarGutter
              onThumb={overflow && scrollbarCell(index, thumb)}
              color={t.scrollIndicator}
            />
          </Box>
        );
        if (!onRowActivate) return rowNode;
        return (
          <RowZone
            key={itemKey}
            zoneId={`${rowZonePrefix}:${itemKey}`}
            z={rowZoneZ}
            onActivate={() => onRowActivate(itemIndex)}
          >
            {rowNode}
          </RowZone>
        );
      })}
      <FillerRows
        count={Math.max(0, visibleRows - visibleSlice.length)}
        color={t.scrollIndicator}
      />
    </>
  );
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
  emptyText = 'No items',
  onRowActivate,
  rowZonePrefix = 'single-column-row',
  rowZoneZ = ROW_ZONE_Z_OVERLAY,
}: SingleColumnPickerProps<T>) {
  const t = useTheme();

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
        <FilterRow filter={filter} isActive={isActive} customFilterPrompt={customFilterPrompt} />
      )}

      <PickerRows
        items={items}
        selectedIndex={selectedIndex}
        isActive={isActive}
        visibleRows={visibleRows}
        getKey={getKey}
        renderRow={renderRow}
        contentMaxWidth={contentMaxWidth}
        placeholderWhenEmpty={placeholderWhenEmpty}
        emptyText={emptyText}
        onRowActivate={onRowActivate}
        rowZonePrefix={rowZonePrefix}
        rowZoneZ={rowZoneZ}
      />
    </Box>
  );
}
