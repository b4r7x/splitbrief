import type { ReactNode } from 'react';
import type { Key } from 'ink';
import { OverlayPanel } from '../overlays/overlay-panel.js';
import { FilterInput, type FilterInputVariant } from '../filter-input.js';
import { useFilterableList } from '../../hooks/use-filterable-list.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { availableRows } from './scroll-window.js';
import { ListViewport, type ListSectionConfig } from './list-viewport.js';

interface FilterableListProps<T> {
  items: T[];
  filterFn: (item: T, query: string) => boolean;
  getKey: (item: T) => string;
  renderItem: (item: T, ctx: { isCursor: boolean; globalIndex: number }) => ReactNode;
  onConfirm?: (item: T) => void;
  onActivate?: (item: T) => void;
  title?: string;
  hint?: string;
  placeholder?: ReactNode;
  chromeRows: number;
  maxVisible?: number;
  listFloor?: number;
  width?: number;
  filterVariant?: FilterInputVariant | undefined;
  filterPlaceholder?: string | undefined;
  shouldAppendChar?: (ch: string) => boolean;
  customKeys?: (
    input: string,
    key: Key,
    ctx: { filtered: T[]; selectedIndex: number },
  ) => boolean | undefined;
  section?: ListSectionConfig<T>;
}

export function FilterableList<T>({
  items,
  filterFn,
  getKey,
  renderItem,
  onConfirm,
  onActivate,
  title,
  hint,
  placeholder,
  chromeRows,
  maxVisible: maxVisibleProp,
  listFloor = 0,
  width,
  filterVariant = 'plain',
  filterPlaceholder,
  shouldAppendChar,
  customKeys,
  section,
}: FilterableListProps<T>) {
  const rows = terminalSizeStore.use((s) => s.rows);
  const viewportRows = availableRows({ rows, chromeRows, floor: listFloor });
  const pageSize =
    maxVisibleProp === undefined ? viewportRows : Math.min(viewportRows, maxVisibleProp);
  const resolvedFilterVariant =
    viewportRows <= 0 && filterVariant === 'plain' ? 'inline' : filterVariant;

  const list = useFilterableList<T>({
    items,
    filterFn,
    onSelect: (item) => onConfirm?.(item),
    onClose: () => overlayStore.close(),
    pageSize,
    ...(shouldAppendChar && { shouldAppendChar }),
    ...(customKeys && { customKeys }),
  });

  const { filter, filtered, selectedIndex } = list;

  const onRowActivate = onActivate ?? onConfirm;

  return (
    <OverlayPanel title={title} hint={hint} maxWidth={width}>
      <FilterInput
        filter={filter}
        variant={resolvedFilterVariant}
        {...(filterPlaceholder !== undefined ? { placeholder: filterPlaceholder } : {})}
      />
      <ListViewport
        items={filtered}
        selectedIndex={selectedIndex}
        getKey={getKey}
        renderItem={renderItem}
        rows={rows}
        chromeRows={chromeRows}
        listFloor={listFloor}
        {...(onRowActivate
          ? {
              onRowActivate: (index: number) => {
                const item = filtered[index];
                if (item !== undefined) onRowActivate(item);
              },
            }
          : {})}
        {...(maxVisibleProp !== undefined ? { maxVisible: maxVisibleProp } : {})}
        {...(placeholder !== undefined ? { placeholder } : {})}
        {...(section !== undefined ? { section } : {})}
      />
    </OverlayPanel>
  );
}
