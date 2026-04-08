import type { ReactNode } from 'react';
import { Box } from 'ink';
import { OverlayPanel } from '../overlays/overlay-panel.js';
import { FilterInput } from '../../ui/filter-input.js';
import { ScrollIndicator } from '../../ui/scroll-indicator.js';
import { useFilterableList } from '../../hooks/use-filterable-list.js';
import { useResponsiveLayout } from '../../hooks/use-terminal-size.js';
import { computeScrollWindow } from '../../ui/picker-utils.js';

interface FilterableListProps<T> {
  items: T[];
  filterFn: (item: T, query: string) => boolean;
  getKey: (item: T) => string;
  renderItem: (item: T, ctx: { isCursor: boolean }) => ReactNode;
  onConfirm?: (item: T) => void;
  onCancel?: () => void;
  title?: string;
  hint?: string;
  placeholder?: ReactNode;
  chromeRows: number;
  maxVisible?: number;
  bordered?: boolean;
  width?: number;
  shouldAppendChar?: (ch: string) => boolean;
  isActive?: boolean;
  // Render-prop escape hatch: when provided, replaces the default item-list body.
  // Gives consumers access to the filtered items + cursor position without a ref.
  children?: (state: {
    filtered: T[];
    cursor: number;
    query: string;
  }) => ReactNode;
}

export function FilterableList<T>({
  items,
  filterFn,
  getKey,
  renderItem,
  onConfirm,
  onCancel,
  title,
  hint,
  placeholder,
  chromeRows,
  maxVisible: maxVisibleProp,
  bordered,
  width,
  shouldAppendChar,
  isActive,
  children,
}: FilterableListProps<T>) {
  const { rows } = useResponsiveLayout();

  const list = useFilterableList<T>({
    items,
    filterFn,
    onSelect: (item) => onConfirm?.(item),
    onClose: onCancel,
    shouldAppendChar,
    isActive,
  });

  const { filter, filtered, selectedIndex } = list;

  const { scrollOffset, visibleSlice, showScrollUp, showScrollDown } =
    computeScrollWindow(filtered, selectedIndex, rows, chromeRows, maxVisibleProp);

  const body = children
    ? children({ filtered, cursor: selectedIndex, query: filter })
    : (
      <>
        {visibleSlice.map((item, i) => {
          const globalIndex = scrollOffset + i;
          return (
            <Box key={getKey(item)}>
              {renderItem(item, { isCursor: globalIndex === selectedIndex })}
            </Box>
          );
        })}
        {filtered.length === 0 && placeholder}
      </>
    );

  return (
    <OverlayPanel
      title={title}
      hint={hint}
      maxWidth={width}
      bordered={bordered}
    >
      <FilterInput filter={filter} />
      <ScrollIndicator show={showScrollUp} direction="up" />
      <Box flexDirection="column">
        {body}
      </Box>
      <ScrollIndicator show={showScrollDown} direction="down" />
    </OverlayPanel>
  );
}
