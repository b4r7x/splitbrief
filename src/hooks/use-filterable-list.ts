import { useEffect, useEffectEvent, useState } from 'react';
import { useInput, type Key } from 'ink';
import { clampIndex, navigateIndex } from '../utils/indexing.js';

interface UseFilterableListOptions<T> {
  items: T[];
  filterFn: (item: T, query: string) => boolean;
  onSelect: (item: T) => void;
  onClose?: (() => void) | undefined;
  isActive?: boolean | undefined;
  shouldAppendChar?: ((input: string) => boolean) | undefined;
  initialIndex?: number | undefined;
  customKeys?: (
    input: string,
    key: Key,
    ctx: { filtered: T[]; selectedIndex: number },
  ) => boolean | undefined;
}

interface UseFilterableListResult<T> {
  filter: string;
  filtered: T[];
  selectedIndex: number;
}

interface PendingSelection<T> {
  id: number;
  item: T;
}

interface FilterableListState<T> {
  filter: string;
  selectedIndex: number;
  pendingSelection: PendingSelection<T> | null;
  nextSelectionId: number;
}

const getFilteredItems = <T>(
  items: T[],
  filterFn: (item: T, query: string) => boolean,
  filter: string,
): T[] => (filter ? items.filter((item) => filterFn(item, filter)) : items);

export function useFilterableList<T>({
  items,
  filterFn,
  onSelect,
  onClose,
  isActive = true,
  shouldAppendChar,
  initialIndex,
  customKeys,
}: UseFilterableListOptions<T>): UseFilterableListResult<T> {
  const [state, setState] = useState<FilterableListState<T>>({
    filter: '',
    selectedIndex: initialIndex ?? 0,
    pendingSelection: null,
    nextSelectionId: 1,
  });
  const commitSelection = useEffectEvent((item: T) => onSelect(item));

  const filtered = getFilteredItems(items, filterFn, state.filter);

  const effectiveIndex = clampIndex(state.selectedIndex, filtered.length);
  const pendingSelection = state.pendingSelection;

  useEffect(() => {
    if (!pendingSelection) return;
    setState((prev) =>
      prev.pendingSelection?.id === pendingSelection.id
        ? { ...prev, pendingSelection: null }
        : prev,
    );
    commitSelection(pendingSelection.item);
  }, [pendingSelection]);

  useInput(
    (input, key) => {
      if (
        customKeys?.(input, key, {
          filtered,
          selectedIndex: effectiveIndex,
        })
      ) {
        return;
      }
      if (key.escape) {
        onClose?.();
        return;
      }
      if (key.return) {
        setState((prev) => {
          const currentFiltered = getFilteredItems(items, filterFn, prev.filter);
          const currentIndex = clampIndex(prev.selectedIndex, currentFiltered.length);
          const selected = currentFiltered[currentIndex];
          if (selected === undefined) return prev;
          return {
            ...prev,
            pendingSelection: { id: prev.nextSelectionId, item: selected },
            nextSelectionId: prev.nextSelectionId + 1,
          };
        });
        return;
      }
      if (key.upArrow) {
        setState((prev) => {
          const currentFiltered = getFilteredItems(items, filterFn, prev.filter);
          return {
            ...prev,
            selectedIndex:
              currentFiltered.length === 0
                ? 0
                : navigateIndex('up', prev.selectedIndex, currentFiltered.length),
          };
        });
        return;
      }
      if (key.downArrow) {
        setState((prev) => {
          const currentFiltered = getFilteredItems(items, filterFn, prev.filter);
          return {
            ...prev,
            selectedIndex:
              currentFiltered.length === 0
                ? 0
                : navigateIndex('down', prev.selectedIndex, currentFiltered.length),
          };
        });
        return;
      }
      if (key.backspace || key.delete) {
        setState((prev) => ({ ...prev, filter: prev.filter.slice(0, -1), selectedIndex: 0 }));
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        if (shouldAppendChar && !shouldAppendChar(input)) return;
        setState((prev) => ({ ...prev, filter: prev.filter + input, selectedIndex: 0 }));
      }
    },
    { isActive },
  );

  return { filter: state.filter, filtered, selectedIndex: effectiveIndex };
}
