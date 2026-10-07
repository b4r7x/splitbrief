import { ThemeText as Text, useTheme } from '../theme.js';
import type { ReactNode } from 'react';
import { Box } from 'ink';
import { glyph } from '../../lib/glyphs.js';
import {
  getScrollbarThumb,
  getScrollViewportContentWidth,
  hasScrollbarOverflow,
  scrollbarCell,
  type ScrollbarColumn,
} from '../scrollbar.js';
import { ScrollIndicator } from '../scroll-indicator.js';
import { computeListDisplayWindow } from './scroll-window.js';
import { RowZone, ROW_ZONE_Z_OVERLAY } from './row-zone.js';

export interface ListSectionConfig<T> {
  by: (item: T) => string;
  renderHeader: (section: string, index: number) => ReactNode;
  gapBetweenSections?: boolean | undefined;
  headerFor?: ((section: string) => boolean) | undefined;
}

interface ListRowContext {
  isCursor: boolean;
  globalIndex: number;
  /** The row's available width, narrowed to leave room for the scrollbar when one is drawn. */
  contentWidth: number;
}

export interface ListDecorationsConfig<T> {
  hasBefore?: ((item: T, index: number) => boolean) | undefined;
  renderBefore?: ((item: T, ctx: ListRowContext) => ReactNode) | undefined;
  hasAfter: (item: T, index: number) => boolean;
  renderAfter: (item: T, ctx: ListRowContext) => ReactNode;
}

interface ListViewportBaseProps<T> {
  items: T[];
  selectedIndex: number;
  /** The horizontal space the list occupies; required for a right-edge scrollbar to be placed. */
  width?: number | undefined;
  /** Where the bar sits relative to `width`; `padding` rides the enclosing frame's padding column. */
  barColumn?: ScrollbarColumn | undefined;
  getKey: (item: T) => string;
  renderItem: (item: T, ctx: ListRowContext) => ReactNode;
  placeholder?: ReactNode;
  section?: ListSectionConfig<T>;
  decorations?: ListDecorationsConfig<T> | undefined;
  pinnedHead?: number | undefined;
  onRowActivate?: ((globalIndex: number) => void) | undefined;
  rowZonePrefix?: string | undefined;
  rowZoneZ?: number | undefined;
  showRemainingCount?: boolean | undefined;
}

type ListViewportExplicitBudgetProps = {
  rowBudget: number;
  rows?: never;
  chromeRows?: never;
  maxVisible?: never;
  listFloor?: never;
};

type ListViewportTerminalBudgetProps = {
  rows: number;
  chromeRows: number;
  maxVisible?: number | undefined;
  listFloor?: number | undefined;
  rowBudget?: never;
};

type ListViewportProps<T> = ListViewportBaseProps<T> &
  (ListViewportExplicitBudgetProps | ListViewportTerminalBudgetProps);

export function ListViewport<T>(props: ListViewportProps<T>) {
  const {
    items,
    selectedIndex,
    width,
    barColumn = 'inside',
    getKey,
    renderItem,
    placeholder,
    section,
    decorations,
    pinnedHead,
    onRowActivate,
    rowZonePrefix = 'list-row',
    rowZoneZ = ROW_ZONE_Z_OVERLAY,
    showRemainingCount = false,
  } = props;
  const t = useTheme();
  const rowBudgetInput =
    props.rowBudget !== undefined
      ? { rowBudget: props.rowBudget }
      : {
          terminalRows: props.rows,
          chromeRows: props.chromeRows,
          maxVisible: props.maxVisible,
          listFloor: props.listFloor,
        };
  const {
    rowBudget: resolvedRows,
    visibleSlots,
    totalSlots,
    scrollOffset,
  } = computeListDisplayWindow({
    items,
    selectedIndex,
    ...rowBudgetInput,
    ...(section
      ? {
          section: {
            by: section.by,
            gapBetweenSections: section.gapBetweenSections,
            headerFor: section.headerFor,
          },
        }
      : {}),
    ...(decorations
      ? { decorations: { before: decorations.hasBefore, after: decorations.hasAfter } }
      : {}),
    ...(pinnedHead === undefined ? {} : { pinnedHead }),
  });
  if (resolvedRows <= 0) return null;

  const visibleItems = visibleSlots.filter((slot) => slot.kind === 'item');
  const lastVisibleItemIndex = visibleItems.at(-1)?.itemIndex ?? -1;
  const remainingBelow = Math.max(0, items.length - lastVisibleItemIndex - 1);

  const contentRows = visibleSlots.filter((slot) => slot.kind !== 'indicator').length;
  const overflows =
    width !== undefined &&
    hasScrollbarOverflow({ lineCount: totalSlots, visibleHeight: contentRows });
  const contentWidth =
    width === undefined
      ? undefined
      : Math.max(1, overflows ? getScrollViewportContentWidth(width, barColumn) : width);
  const rowContentWidth = contentWidth ?? Number.POSITIVE_INFINITY;
  const thumb = getScrollbarThumb({
    offset: scrollOffset,
    lineCount: totalSlots,
    visibleHeight: contentRows,
  });

  const content = (
    <Box flexDirection="column" width={contentWidth} flexShrink={0}>
      {visibleSlots.map((slot, i) => {
        switch (slot.kind) {
          case 'indicator':
            return (
              <ScrollIndicator
                key={`indicator-${slot.direction}-${i}`}
                show
                direction={slot.direction}
                {...(showRemainingCount && slot.direction === 'down'
                  ? { count: remainingBelow }
                  : {})}
              />
            );
          case 'header':
            return (
              <Box key={`header-${slot.section}-${slot.itemIndex}`}>
                {section?.renderHeader(slot.section, i)}
              </Box>
            );
          case 'gap':
            return <Box key={`gap-${slot.itemIndex}-${i}`} height={1} />;
          case 'before':
          case 'after': {
            const item = items[slot.itemIndex];
            if (item === undefined || decorations === undefined) return null;
            const ctx = {
              isCursor: slot.itemIndex === selectedIndex,
              globalIndex: slot.itemIndex,
              contentWidth: rowContentWidth,
            };
            return (
              <Box key={`${slot.kind}-${slot.itemIndex}`}>
                {slot.kind === 'before'
                  ? (decorations.renderBefore?.(item, ctx) ?? null)
                  : decorations.renderAfter(item, ctx)}
              </Box>
            );
          }
          case 'item': {
            const rendered = renderItem(slot.item, {
              isCursor: slot.itemIndex === selectedIndex,
              globalIndex: slot.itemIndex,
              contentWidth: rowContentWidth,
            });
            const itemIndex = slot.itemIndex;
            return onRowActivate ? (
              <RowZone
                key={getKey(slot.item)}
                zoneId={`${rowZonePrefix}:${getKey(slot.item)}`}
                z={rowZoneZ}
                onActivate={() => onRowActivate(itemIndex)}
              >
                {rendered}
              </RowZone>
            ) : (
              <Box key={getKey(slot.item)}>{rendered}</Box>
            );
          }
          default: {
            const _exhaustive: never = slot;
            return _exhaustive;
          }
        }
      })}
      {items.length === 0 && placeholder}
    </Box>
  );

  return (
    <Box
      flexDirection="row"
      width={overflows && barColumn === 'padding' && width !== undefined ? width + 1 : undefined}
    >
      {content}
      {overflows && (
        <Box flexDirection="column" flexShrink={0} marginLeft={1}>
          {Array.from({ length: contentRows }, (_, rowIndex) => {
            const onThumb = scrollbarCell(rowIndex, thumb);
            return (
              <Text key={`scrollbar-${rowIndex}`} color={onThumb ? t.accent : t.scrollIndicator}>
                {onThumb ? glyph('scrollThumb') : glyph('scrollTrack')}
              </Text>
            );
          })}
        </Box>
      )}
    </Box>
  );
}
