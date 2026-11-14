import { useLayoutEffect, useRef } from 'react';
import { clampIndex, rotateIndex } from '../../../utils/indexing.js';
import { useKeyState } from '../../../hooks/use-key-state.js';

export interface ColumnStateHook<T> {
  filter: string;
  index: number;
  items: T[];
  effectiveIndex: number;
  currentItem: T | undefined;
  setFilter: (update: (prev: string) => string) => void;
  setIndex: (index: number) => T | undefined;
  moveBy: (direction: 1 | -1) => T | undefined;
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
  const [filter, setFilterState, latestFilter] = useKeyState('');
  const [storedIndex, setIndexState, latestIndex] = useKeyState(initialIndex);

  const sourceRef = useRef(source);
  const notifiedKey = useRef<string | null>(null);
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
  // Follow the selected key across a reorder in the render itself: a render on the row that took
  // its place reaches the caller's rules and a queued key that runs in the same commit.
  const remembered = notifiedKey.current;
  const storedItem = itemAt(clampIndex(storedIndex, items.length + virtualCount), items);
  const realIndex =
    storedItem === undefined || remembered === null || getKey(storedItem) === remembered
      ? -1
      : items.findIndex((item) => getKey(item) === remembered);
  const index = realIndex >= 0 ? realIndex + virtualCount : storedIndex;
  const effectiveIndex = clampIndex(index, items.length + virtualCount);
  const currentItem = itemAt(effectiveIndex, items);

  const notifyCurrentItem = (item: T | undefined) => {
    if (item !== undefined) notifiedKey.current = getKey(item);
    onCurrentItemChange?.(item);
  };

  // Clamp and notify only when the selected key is gone. A key queued in this commit reads the index
  // set here: `useNavState` declares its input queue, and so its layout effect, after this hook.
  useLayoutEffect(() => {
    if (index !== storedIndex) setIndexState(index);
    if (currentItem === undefined) return;
    if (remembered !== null && getKey(currentItem) === remembered) return;
    notifyCurrentItem(currentItem);
  });

  const setIndex = (next: number) => {
    const nextItems = getItems(latestFilter());
    const clamped = clampIndex(next, nextItems.length + virtualCount);
    setIndexState(clamped);
    const landed = itemAt(clamped, nextItems);
    notifyCurrentItem(landed);
    return landed;
  };

  const moveBy = (direction: 1 | -1) => {
    const nextItems = getItems(latestFilter());
    const length = nextItems.length + virtualCount;
    if (length === 0) return undefined;
    const next = rotateIndex(clampIndex(latestIndex(), length), length, direction);
    return setIndex(next);
  };

  const setFilter = (update: (prev: string) => string) => {
    const nextFilter = update(latestFilter());
    if (nextFilter === latestFilter()) return;
    const nextItems = getItems(nextFilter);
    setFilterState(nextFilter);
    notifyCurrentItem(itemAt(latestIndex(), nextItems));
  };

  return {
    filter,
    index,
    items,
    effectiveIndex,
    currentItem,
    setFilter,
    setIndex,
    moveBy,
    reset: (next) => {
      setIndexState(next);
      setFilterState('');
      notifiedKey.current = null;
    },
  };
}
