import { useState } from 'react';
import { clampIndex } from '../../../utils/indexing.js';

export interface ColumnStateHook<T> {
  filter: string;
  index: number;
  items: T[];
  effectiveIndex: number;
  currentItem: T | undefined;
  setFilter: (update: (prev: string) => string) => void;
  setIndex: (index: number) => void;
  reset: (initialIndex: number) => void;
}

export interface ColumnStateInput<T> {
  source: T[];
  filterFn: (item: T, query: string) => boolean;
  initialIndex: number;
}

export function useColumnState<T>(input: ColumnStateInput<T>): ColumnStateHook<T> {
  const { source, filterFn, initialIndex } = input;
  const [filter, setFilterState] = useState('');
  const [index, setIndex] = useState(initialIndex);

  const items = filter ? source.filter((item) => filterFn(item, filter)) : source;
  const effectiveIndex = clampIndex(index, items.length);
  const currentItem = items[effectiveIndex];

  return {
    filter,
    index,
    items,
    effectiveIndex,
    currentItem,
    setFilter: (update) => setFilterState(update),
    setIndex,
    reset: (next) => {
      setIndex(next);
      setFilterState('');
    },
  };
}
