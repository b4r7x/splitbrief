import { ThemeText as Text, useTheme } from '../../../components/theme.js';
import type { ReactNode } from 'react';
import { Box } from 'ink';
import { PanelSurface } from '../../../components/overlays/surface.js';
import { PanelRow } from '../../../components/overlays/row.js';
import { borderStyleFor, glyph } from '../../../lib/glyphs.js';
import {
  getScrollbarThumb,
  hasScrollbarOverflow,
  scrollbarCell,
} from '../../../components/scrollbar.js';
import { windowSlice } from '../../../components/pickers/scroll-offset.js';
import { RowZone, ROW_ZONE_Z_OVERLAY } from '../../../components/pickers/row-zone.js';

interface SingleColumnPickerProps<T> {
  label: ReactNode;
  details?: ReactNode;
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
  emptyText?: string;
  onRowActivate?: ((globalIndex: number) => void) | undefined;
  onWheel?: ((direction: 'up' | 'down') => void) | undefined;
  rowZonePrefix?: string | undefined;
  rowZoneZ?: number | undefined;
  isAction?: ((item: T) => boolean) | undefined;
  lineCountOf?: ((item: T) => number) | undefined;
}

function ScrollbarGutter({
  onThumb,
  visible,
  color,
}: {
  onThumb: boolean;
  visible: boolean;
  color: string | undefined;
}) {
  let mark = ' ';
  if (onThumb) mark = glyph('scrollThumb');
  else if (visible) mark = glyph('scrollTrack');
  return (
    <Box marginLeft={1}>
      <Text color={color}>{mark}</Text>
    </Box>
  );
}

function FilterRow({
  filter,
  isActive,
}: Pick<SingleColumnPickerProps<unknown>, 'filter' | 'isActive'>) {
  const t = useTheme();
  return (
    <Box>
      <Text color={t.accent}>{isActive ? `${glyph('prompt')} ` : '  '}</Text>
      <Text color={filter ? t.text : t.textDim}>{filter || 'Type to filter…'}</Text>
    </Box>
  );
}

function FillerRows({
  count,
  color,
  visible,
}: {
  count: number;
  color: string | undefined;
  visible: boolean;
}) {
  return Array.from({ length: count }, (_, index) => (
    <Box key={`scrollbar-filler-${index}`}>
      <Box flexGrow={1} />
      <ScrollbarGutter onThumb={false} visible={visible} color={color} />
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
  | 'onWheel'
  | 'lineCountOf'
  | 'isAction'
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
  onWheel,
  rowZonePrefix,
  rowZoneZ,
  isAction,
  lineCountOf,
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
          <ScrollbarGutter onThumb={false} visible={false} color={t.scrollIndicator} />
        </Box>
        <FillerRows count={visibleRows - 1} color={t.scrollIndicator} visible={false} />
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
  const renderedLineCount = visibleSlice.reduce(
    (sum, item) => sum + (lineCountOf ? lineCountOf(item) : 1),
    0,
  );

  return (
    <>
      {visibleSlice.map((item, index) => {
        const itemIndex = scrollOffset + index;
        const itemKey = getKey(item);
        const isCursor = isActive && itemIndex === selectedIndex && (isAction?.(item) ?? true);
        const rowNode = (
          <PanelRow key={itemKey} width="100%" active={isCursor}>
            <Box flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">
              {renderRow(item, isCursor, rowContentWidth)}
            </Box>
            <ScrollbarGutter
              onThumb={overflow && scrollbarCell(index, thumb)}
              visible={overflow}
              color={t.scrollIndicator}
            />
          </PanelRow>
        );
        if (!onRowActivate) return rowNode;
        return (
          <RowZone
            key={itemKey}
            zoneId={`${rowZonePrefix}:${itemKey}`}
            z={rowZoneZ}
            onActivate={() => onRowActivate(itemIndex)}
            onWheel={onWheel}
          >
            {rowNode}
          </RowZone>
        );
      })}
      <FillerRows
        count={Math.max(0, visibleRows - renderedLineCount)}
        color={t.scrollIndicator}
        visible={overflow}
      />
    </>
  );
}

export function SingleColumnPicker<T>({
  label,
  details,
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
  emptyText = 'No items',
  onRowActivate,
  onWheel,
  rowZonePrefix = 'single-column-row',
  rowZoneZ = ROW_ZONE_Z_OVERLAY,
  isAction,
  lineCountOf,
}: SingleColumnPickerProps<T>) {
  const t = useTheme();

  return (
    <PanelSurface
      flexDirection="column"
      flexGrow={1}
      flexBasis={0}
      height={height}
      borderStyle={borderStyleFor('round')}
      borderColor={isActive ? t.accent : t.border}
      paddingX={1}
    >
      {typeof label === 'string' ? (
        <Text color={isActive ? t.accent : t.textDim}>{label}</Text>
      ) : (
        label
      )}

      <FilterRow filter={filter} isActive={isActive} />

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
        onWheel={onWheel}
        rowZonePrefix={rowZonePrefix}
        rowZoneZ={rowZoneZ}
        isAction={isAction}
        lineCountOf={lineCountOf}
      />
      {details}
    </PanelSurface>
  );
}
