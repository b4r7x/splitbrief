import { useState } from 'react';

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

const clampIndex = (index: number, length: number) => Math.min(index, Math.max(0, length - 1));

export function useColumnState<T>(
  source: T[],
  filterFn: (item: T, query: string) => boolean,
  initialIndex: number,
): ColumnStateHook<T> {
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
