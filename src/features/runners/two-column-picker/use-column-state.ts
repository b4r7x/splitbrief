import { useLayoutEffect, useRef, useState } from 'react';
import { clampIndex } from '../../../utils/indexing.js';

export interface ColumnStateHook<T> {
  filter: string;
  index: number;
  items: T[];
  effectiveIndex: number;
  currentItem: T | undefined;
  setFilter: (update: (prev: string) => string) => void;
  setIndex: (index: number) => T | undefined;
  reset: (initialIndex: number) => void;
}

export interface ColumnStateInput<T> {
  source: T[];
  filterFn: (item: T, query: string) => boolean;
  getKey: (item: T) => string;
  initialIndex: number;
  /**
   * Rows the caller prepends to the rendered list (the virtual "+ Add custom…"
   * row). The index travels in combined-list coordinates, so clamping must
   * count these rows or the selection can never reach the last real item.
   */
  virtualCount?: number | undefined;
  compare?: ((a: T, b: T) => number) | undefined;
  onCurrentItemChange?: ((item: T | undefined) => void) | undefined;
}

export function useColumnState<T>(input: ColumnStateInput<T>): ColumnStateHook<T> {
  const {
    source,
    filterFn,
    getKey,
    initialIndex,
    virtualCount = 0,
    compare,
    onCurrentItemChange,
  } = input;
  const [filter, setFilterState] = useState('');
  const [index, setIndexState] = useState(initialIndex);

  const filterRef = useRef(filter);
  const indexRef = useRef(index);
  const sourceRef = useRef(source);
  filterRef.current = filter;
  indexRef.current = index;
  sourceRef.current = source;

  const getItems = (filterValue: string, src: T[] = sourceRef.current) => {
    if (!filterValue) return src;
    const filtered = src.filter((item) => filterFn(item, filterValue));
    if (!compare) return filtered;
    return filtered.toSorted(compare);
  };

  const itemAt = (nextIndex: number, nextItems: T[]) =>
    nextIndex < virtualCount
      ? undefined
      : nextItems[clampIndex(nextIndex - virtualCount, nextItems.length)];

  const items = getItems(filter);
  const effectiveIndex = clampIndex(index, items.length + virtualCount);
  const currentItem = itemAt(effectiveIndex, items);

  const notifiedKey = useRef<string | null>(null);
  const notifyCurrentItem = (item: T | undefined) => {
    if (item !== undefined) notifiedKey.current = getKey(item);
    onCurrentItemChange?.(item);
  };

  // The selection is an index, so a source list that re-sorts or re-filters
  // under it moves to another item without any call below — re-notify on the
  // key change.
  useLayoutEffect(() => {
    if (currentItem === undefined || getKey(currentItem) === notifiedKey.current) return;
    notifyCurrentItem(currentItem);
  });

  const setIndex = (next: number) => {
    const nextItems = getItems(filterRef.current);
    const clamped = clampIndex(next, nextItems.length + virtualCount);
    indexRef.current = clamped;
    setIndexState(clamped);
    const landed = itemAt(clamped, nextItems);
    notifyCurrentItem(landed);
    return landed;
  };

  const setFilter = (update: (prev: string) => string) => {
    const nextFilter = update(filterRef.current);
    if (nextFilter === filterRef.current) return;
    filterRef.current = nextFilter;
    const nextItems = getItems(nextFilter);
    setFilterState(nextFilter);
    notifyCurrentItem(itemAt(indexRef.current, nextItems));
  };

  return {
    filter,
    index,
    items,
    effectiveIndex,
    currentItem,
    setFilter,
    setIndex,
    reset: (next) => {
      filterRef.current = '';
      indexRef.current = next;
      setIndexState(next);
      setFilterState('');
      notifyCurrentItem(itemAt(next, sourceRef.current));
    },
  };
}
