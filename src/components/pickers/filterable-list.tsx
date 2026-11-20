import type { ReactNode } from 'react';
import { Box } from 'ink';
import type { Key } from 'ink';
import { OverlayPanel } from '../overlays/panel.js';
import { layoutPanelNotice, Notice, PANEL_NOTICE_ROWS } from '../notice.js';
import { FilterInput } from '../filter-input.js';
import type { FilterableListKeyContext } from '../../hooks/use-filterable-list.js';
import { useFilterableList } from '../../hooks/use-filterable-list.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { useStores } from '../../stores/use-many.js';
import { type OverlayDensity, overlayRect } from '../../core/navigation/overlay-rect.js';
import { overlayStore } from '../../stores/ui/overlay.js';
import { overlayListRows } from './scroll-offset.js';
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
  title: string;
  hint: string;
  notice?: string | null;
  placeholder?: ReactNode;
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
  notice,
  placeholder,
  density,
  filterPlaceholder,
  shouldAppendChar,
  customKeys,
  section,
}: FilterableListProps<T>) {
  const [{ cols, rows }] = useStores(terminalSizeStore);
  const { innerWidth, innerRows } = overlayRect({ cols, rows, density });
  // Both the title and the filter use one line and one row of spacing.
  const listRoom = overlayListRows(innerRows, 4);
  const warning = layoutPanelNotice(
    { message: notice ?? null, severity: 'warning' },
    { width: innerWidth, maxRows: Math.min(PANEL_NOTICE_ROWS, listRoom - 4) },
  );
  const rowBudget = Math.max(0, listRoom - (warning?.height ?? 0));

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
      {warning !== null && <Notice layout={warning} />}
    </OverlayPanel>
  );
}
