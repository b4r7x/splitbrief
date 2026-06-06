import type { ReactNode } from 'react';
import { Box, type Key } from 'ink';
import { OverlayPanel } from '../overlays/overlay-panel.js';
import { FilterInput } from '../filter-input.js';
import { ScrollIndicator } from '../scroll-indicator.js';
import { useFilterableList } from '../../hooks/use-filterable-list.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { computeScrollWindow } from './scroll-window.js';
import { toSectionedList } from '../../utils/sectioned-list.js';

interface FilterableListProps<T> {
  items: T[];
  filterFn: (item: T, query: string) => boolean;
  getKey: (item: T) => string;
  renderItem: (item: T, ctx: { isCursor: boolean; globalIndex: number }) => ReactNode;
  onConfirm?: (item: T) => void;
  title?: string;
  hint?: string;
  placeholder?: ReactNode;
  chromeRows: number;
  maxVisible?: number;
  bordered?: boolean;
  width?: number;
  shouldAppendChar?: (ch: string) => boolean;
  customKeys?: (
    input: string,
    key: Key,
    ctx: { filtered: T[]; selectedIndex: number },
  ) => boolean | undefined;
  sectionBy?: (item: T) => string;
  renderSectionHeader?: (section: string, index: number) => ReactNode;
}

export function FilterableList<T>({
  items,
  filterFn,
  getKey,
  renderItem,
  onConfirm,
  title,
  hint,
  placeholder,
  chromeRows,
  maxVisible: maxVisibleProp,
  bordered,
  width,
  shouldAppendChar,
  customKeys,
  sectionBy,
  renderSectionHeader,
}: FilterableListProps<T>) {
  const rows = terminalSizeStore.use((s) => s.rows);

  const list = useFilterableList<T>({
    items,
    filterFn,
    onSelect: (item) => onConfirm?.(item),
    onClose: () => overlayStore.close(),
    ...(shouldAppendChar && { shouldAppendChar }),
    ...(customKeys && { customKeys }),
  });

  const { filter, filtered, selectedIndex } = list;

  const { scrollOffset, visibleSlice, showScrollUp, showScrollDown } = computeScrollWindow({
    items: filtered,
    selectedIndex,
    terminalRows: rows,
    chromeRows,
    maxVisible: maxVisibleProp,
  });

  const useSections = sectionBy && renderSectionHeader;
  const sectionedSlice = useSections ? toSectionedList(visibleSlice, sectionBy) : null;

  return (
    <OverlayPanel title={title} hint={hint} maxWidth={width} bordered={bordered}>
      <FilterInput filter={filter} />
      <ScrollIndicator show={showScrollUp} direction="up" />
      <Box flexDirection="column">
        {sectionedSlice && renderSectionHeader
          ? sectionedSlice.map(({ item, sectionHeader }, i) => {
              const globalIndex = scrollOffset + i;
              return (
                <Box key={getKey(item)} flexDirection="column">
                  {sectionHeader && renderSectionHeader(sectionHeader, i)}
                  {renderItem(item, { isCursor: globalIndex === selectedIndex, globalIndex })}
                </Box>
              );
            })
          : visibleSlice.map((item, i) => {
              const globalIndex = scrollOffset + i;
              return (
                <Box key={getKey(item)}>
                  {renderItem(item, { isCursor: globalIndex === selectedIndex, globalIndex })}
                </Box>
              );
            })}
        {filtered.length === 0 && placeholder}
      </Box>
      <ScrollIndicator show={showScrollDown} direction="down" />
    </OverlayPanel>
  );
}
