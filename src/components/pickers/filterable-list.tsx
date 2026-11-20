import type { ReactNode } from 'react';
import { Box } from 'ink';
import type { Key } from 'ink';
import { OverlayPanel } from '../overlays/panel.js';
import { FilterInput } from '../filter-input.js';
import type { FilterableListKeyContext } from '../../hooks/use-filterable-list.js';
import { useFilterableList } from '../../hooks/use-filterable-list.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { useStores } from '../../stores/use-many.js';
import { type OverlayDensity, overlayRect } from '../../core/navigation/overlay-rect.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { availableRows } from './scroll-offset.js';
import { ListRows, planViewportRows } from '../list-row/rows.js';
import type { ListRowModel } from '../list-row/plan.js';
import type { ListSectionConfig } from './list-viewport.js';

interface FilterableListProps<T> {
  items: T[];
  filterFn: (item: T, query: string) => boolean;
  getKey: (item: T) => string;
  rowModel: (item: T) => ListRowModel;
  onConfirm?: (item: T) => void;
  onActivate?: (item: T) => void;
  title?: string;
  hint?: string;
  placeholder?: ReactNode;
  chromeRows: number;
  maxVisible?: number;
  listFloor?: number;
  density: OverlayDensity;
  filterPlaceholder?: string | undefined;
  shouldAppendChar?: (ch: string) => boolean;
  customKeys?: (input: string, key: Key, ctx: FilterableListKeyContext<T>) => boolean | undefined;
  section?: ListSectionConfig<T>;
}

export function FilterableList<T>({
  items,
  filterFn,
  getKey,
  rowModel,
  onConfirm,
  onActivate,
  title,
  hint,
  placeholder,
  chromeRows,
  maxVisible: maxVisibleProp,
  listFloor = 0,
  density,
  filterPlaceholder,
  shouldAppendChar,
  customKeys,
  section,
}: FilterableListProps<T>) {
  const [{ cols, rows }] = useStores(terminalSizeStore);
  const { innerWidth } = overlayRect({ cols, rows, density });
  const available = availableRows({ rows, chromeRows, floor: listFloor });
  const rowBudget =
    maxVisibleProp === undefined
      ? available
      : Math.max(0, Math.min(available, Math.floor(maxVisibleProp)));

  const list = useFilterableList<T>({
    items,
    getKey,
    filterFn,
    onSelect: (item) => onConfirm?.(item),
    ...(onActivate ? { onItemAction: onActivate } : {}),
    onClose: () => overlayStore.close(),
    pageSize: rowBudget,
    ...(shouldAppendChar && { shouldAppendChar }),
    ...(customKeys && { customKeys }),
  });

  const { filter, filtered, selectedIndex } = list;

  const sectionOf = section
    ? (i: number) => (filtered[i] === undefined ? '' : section.by(filtered[i]))
    : undefined;
  return (
    <OverlayPanel title={title} hint={hint} density={density}>
      <Box marginBottom={1}>
        <FilterInput
          filter={filter}
          {...(filterPlaceholder !== undefined ? { placeholder: filterPlaceholder } : {})}
        />
      </Box>
      <ListRows
        focused
        width={innerWidth}
        lines={planViewportRows(
          filtered.map(rowModel),
          innerWidth,
          rowBudget,
          sectionOf,
          section?.gapBetweenSections,
        )}
        selectedIndex={selectedIndex}
        getKey={(i) => (filtered[i] === undefined ? '' : getKey(filtered[i]))}
        rowBudget={rowBudget}
        {...(onActivate || onConfirm
          ? {
              onActivate: (index: number) => {
                const item = filtered[index];
                if (item === undefined) return;
                if (onActivate) {
                  list.runItemAction(item);
                } else {
                  list.selectItem(item);
                }
              },
            }
          : {})}
        {...(placeholder !== undefined ? { placeholder } : {})}
        {...(section !== undefined
          ? {
              section: sectionOf,
              gapBetweenSections: section.gapBetweenSections,
            }
          : {})}
      />
    </OverlayPanel>
  );
}
