import type { ReactNode } from 'react';
import { Box } from 'ink';
import { ScrollIndicator } from '../scroll-indicator.js';
import { computeListDisplayWindow } from './scroll-window.js';
import { RowZone, ROW_ZONE_Z_OVERLAY } from './row-zone.js';

export interface ListSectionConfig<T> {
  by: (item: T) => string;
  renderHeader: (section: string, index: number) => ReactNode;
  gapBetweenSections?: boolean | undefined;
}

interface ListViewportBaseProps<T> {
  items: T[];
  selectedIndex: number;
  getKey: (item: T) => string;
  renderItem: (item: T, ctx: { isCursor: boolean; globalIndex: number }) => ReactNode;
  placeholder?: ReactNode;
  section?: ListSectionConfig<T>;
  onRowActivate?: ((globalIndex: number) => void) | undefined;
  rowZonePrefix?: string | undefined;
  rowZoneZ?: number | undefined;
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
    getKey,
    renderItem,
    placeholder,
    section,
    onRowActivate,
    rowZonePrefix = 'list-row',
    rowZoneZ = ROW_ZONE_Z_OVERLAY,
  } = props;
  const rowBudgetInput =
    props.rowBudget !== undefined
      ? { rowBudget: props.rowBudget }
      : {
          terminalRows: props.rows,
          chromeRows: props.chromeRows,
          maxVisible: props.maxVisible,
          listFloor: props.listFloor,
        };
  const { rowBudget: resolvedRows, visibleSlots } = computeListDisplayWindow({
    items,
    selectedIndex,
    ...rowBudgetInput,
    ...(section
      ? { section: { by: section.by, gapBetweenSections: section.gapBetweenSections } }
      : {}),
  });
  if (resolvedRows <= 0) return null;

  return (
    <Box flexDirection="column">
      {visibleSlots.map((slot, i) => {
        switch (slot.kind) {
          case 'indicator':
            return (
              <ScrollIndicator
                key={`indicator-${slot.direction}-${i}`}
                show
                direction={slot.direction}
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
          case 'item': {
            const rendered = renderItem(slot.item, {
              isCursor: slot.itemIndex === selectedIndex,
              globalIndex: slot.itemIndex,
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
}
