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
  onCurrentItemChange?: ((item: T | undefined) => void) | undefined;
}

export function useColumnState<T>(input: ColumnStateInput<T>): ColumnStateHook<T> {
  const { source, filterFn, getKey, initialIndex, onCurrentItemChange } = input;
  const [filter, setFilterState] = useState('');
  const [index, setIndexState] = useState(initialIndex);

  const filterRef = useRef(filter);
  const indexRef = useRef(index);
  const sourceRef = useRef(source);
  filterRef.current = filter;
  indexRef.current = index;
  sourceRef.current = source;

  const getItems = (filterValue: string, src: T[] = sourceRef.current) =>
    filterValue ? src.filter((item) => filterFn(item, filterValue)) : src;

  const items = getItems(filter);
  const effectiveIndex = clampIndex(index, items.length);
  const currentItem = items[effectiveIndex];

  const notifiedKey = useRef<string | null>(null);
  const notifyCurrentItem = (item: T | undefined) => {
    if (item !== undefined) notifiedKey.current = getKey(item);
    onCurrentItemChange?.(item);
  };

  // The cursor is an index, so a source list that re-sorts or re-filters under it
  // moves to another item without any call below — re-notify on the key change.
  useLayoutEffect(() => {
    if (currentItem === undefined || getKey(currentItem) === notifiedKey.current) return;
    notifyCurrentItem(currentItem);
  });

  const itemAt = (nextIndex: number, nextItems: T[]) =>
    nextItems[clampIndex(nextIndex, nextItems.length)];

  const setIndex = (next: number) => {
    const nextItems = getItems(filterRef.current);
    const clamped = clampIndex(next, nextItems.length);
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
