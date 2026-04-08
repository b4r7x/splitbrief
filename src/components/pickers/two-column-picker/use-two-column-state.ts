import { useState, type ReactNode } from 'react';
import { useInput } from 'ink';
import { filterByFields, type FilterableItem } from '../../../ui/picker-utils.js';

export const CUSTOM_ROW_ID = '__custom__' as const;

export type VirtualCustomItem = { id: typeof CUSTOM_ROW_ID; isVirtual: true };
export type RightItemOrVirtual<R> = R | VirtualCustomItem;

export function isVirtualCustomItem<R extends { id: string }>(item: RightItemOrVirtual<R>): item is VirtualCustomItem {
  return 'isVirtual' in item && (item as VirtualCustomItem).isVirtual === true;
}

export interface ColumnState<T> {
  filter: string;
  items: T[];
  index: number;
  currentItem: T | undefined;
}

export interface TwoColumnNavState<L, R> {
  activeColumn: 'left' | 'right';
  left: ColumnState<L>;
  right: ColumnState<RightItemOrVirtual<R>>;
  selectedLeftKey: string | null;
  isSpecial: boolean;
  isOnCustomItem: boolean;
  isOnLeftCustomItem: boolean;
  currentRightIsCustom: boolean;
}

export interface UseTwoColumnStateParams<L extends FilterableItem, R extends { id: string }> {
  leftItems: L[];
  rightItems: R[];
  leftGetKey: (item: L) => string;
  leftFilterFn?: (item: L, query: string) => boolean;
  rightFilterFn?: (item: R, query: string) => boolean;
  isLeftItemSpecial?: (item: L) => boolean;
  isLeftItemDisabled?: (item: L) => boolean;
  isRightItemCustom?: (item: R) => boolean;
  initialColumn?: 'left' | 'right';
  initialLeftIndex?: number;
  allowCustomRight?: boolean;
  rightPlaceholder?: ReactNode;
  onLeftChange: (item: L) => void;
  onConfirm: (left: L, right: R | null) => void;
  onCancel: () => void;
  onCustomRightOverlay?: (left: L) => void;
  onDeleteRight?: (item: R) => void;
}

function defaultLeftFilter<L extends FilterableItem>(item: L, query: string): boolean {
  return filterByFields(item, query, ['id', 'displayName']);
}

function defaultRightFilter<R extends { id: string }>(item: R, query: string): boolean {
  return filterByFields(item, query, ['id']);
}

function findNextEnabled<T>(
  items: T[],
  from: number,
  direction: 1 | -1,
  isDisabled?: (item: T) => boolean,
): number {
  if (items.length === 0) return from;
  if (!isDisabled) return (from + direction + items.length) % items.length;
  let next = (from + direction + items.length) % items.length;
  let steps = 0;
  while (isDisabled(items[next]) && steps < items.length) {
    next = (next + direction + items.length) % items.length;
    steps++;
  }
  return steps >= items.length ? from : next;
}

export function useTwoColumnState<L extends FilterableItem, R extends { id: string }>(
  params: UseTwoColumnStateParams<L, R>,
): TwoColumnNavState<L, R> {
  const {
    leftItems, rightItems, leftGetKey, leftFilterFn, rightFilterFn,
    isLeftItemSpecial, isLeftItemDisabled, isRightItemCustom,
    initialColumn = 'left', initialLeftIndex, allowCustomRight, rightPlaceholder,
    onLeftChange, onConfirm, onCancel, onCustomRightOverlay, onDeleteRight,
  } = params;

  const [activeColumn, setActiveColumn] = useState<'left' | 'right'>(initialColumn);
  const [selectedLeftKey, setSelectedLeftKey] = useState<string | null>(null);
  const [leftFilter, setLeftFilter] = useState('');
  const [rightFilter, setRightFilter] = useState('');
  const [leftIndex, setLeftIndex] = useState(initialLeftIndex ?? 0);
  const [rightIndex, setRightIndex] = useState(0);

  const leftFilterFnEff = leftFilterFn ?? defaultLeftFilter;
  const rightFilterFnEff = rightFilterFn ?? defaultRightFilter;

  const leftFiltered = leftFilter ? leftItems.filter((it) => leftFilterFnEff(it, leftFilter)) : leftItems;
  const rightFiltered = rightFilter ? rightItems.filter((it) => rightFilterFnEff(it, rightFilter)) : rightItems;

  const filteredRight: RightItemOrVirtual<R>[] = allowCustomRight
    ? [{ id: CUSTOM_ROW_ID, isVirtual: true } as VirtualCustomItem, ...rightFiltered]
    : rightFiltered;

  const leftEffectiveIndex = Math.min(leftIndex, Math.max(0, leftFiltered.length - 1));
  const rightEffectiveIndex = Math.min(rightIndex, Math.max(0, filteredRight.length - 1));
  const leftCurrentItem = leftFiltered[leftEffectiveIndex];
  const rightCurrentItem = filteredRight[rightEffectiveIndex];

  const isSpecial = leftCurrentItem ? (isLeftItemSpecial?.(leftCurrentItem) ?? false) : false;
  const isDisabled = leftCurrentItem ? (isLeftItemDisabled?.(leftCurrentItem) ?? false) : false;
  const leftActive = activeColumn === 'left';
  const rightActive = activeColumn === 'right';
  const isOnVirtual = !!rightCurrentItem && isVirtualCustomItem(rightCurrentItem);
  const currentRightIsCustom = rightActive && !!rightCurrentItem && !isOnVirtual
    && (isRightItemCustom?.(rightCurrentItem as R) ?? false);

  useInput((input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }

    if (key.ctrl && input === 'd') {
      if (rightActive && currentRightIsCustom && onDeleteRight) {
        const item = filteredRight[rightEffectiveIndex];
        if (item && !isVirtualCustomItem(item) && isRightItemCustom?.(item)) {
          onDeleteRight(item);
        }
      }
      return;
    }

    if (key.leftArrow) {
      if (rightActive) {
        setActiveColumn('left');
        setSelectedLeftKey(null);
      }
      return;
    }

    if (key.rightArrow) {
      if (leftActive && leftCurrentItem && !isDisabled && !isSpecial && (rightItems.length > 0 || rightPlaceholder)) {
        setActiveColumn('right');
      }
      return;
    }

    if (key.upArrow || key.downArrow) {
      const direction: 1 | -1 = key.upArrow ? -1 : 1;
      if (leftActive) {
        if (leftFiltered.length === 0) return;
        const next = findNextEnabled(leftFiltered, leftEffectiveIndex, direction, isLeftItemDisabled);
        setLeftIndex(next);
        const nextItem = leftFiltered[next];
        if (nextItem) {
          onLeftChange(nextItem);
          setRightIndex(0);
          setRightFilter('');
        }
      } else {
        if (filteredRight.length === 0) return;
        const next = findNextEnabled(filteredRight, rightEffectiveIndex, direction);
        setRightIndex(next);
      }
      return;
    }

    if (key.return) {
      if (leftActive) {
        if (!leftCurrentItem || isDisabled) return;
        if (isSpecial) {
          onConfirm(leftCurrentItem, null);
          return;
        }
        setSelectedLeftKey(leftGetKey(leftCurrentItem));
        if (rightItems.length > 0 || rightPlaceholder) setActiveColumn('right');
        return;
      }
      if (isOnVirtual) {
        if (onCustomRightOverlay && leftCurrentItem) onCustomRightOverlay(leftCurrentItem);
        return;
      }
      const rc = filteredRight[rightEffectiveIndex];
      const ri = rc && !isVirtualCustomItem(rc) ? rc : null;
      if (leftFiltered[leftEffectiveIndex]) onConfirm(leftFiltered[leftEffectiveIndex], ri);
      return;
    }

    if (key.backspace || key.delete) {
      if (leftActive && !isSpecial) {
        setLeftFilter((prev) => prev.slice(0, -1));
        setLeftIndex(0);
      } else if (rightActive) {
        setRightFilter((prev) => prev.slice(0, -1));
        setRightIndex(0);
      }
      return;
    }

    if (input && !key.ctrl && !key.meta) {
      if (leftActive && !isSpecial) {
        setLeftFilter((prev) => prev + input);
        setLeftIndex(0);
      } else if (rightActive) {
        setRightFilter((prev) => prev + input);
        setRightIndex(0);
      }
    }
  }, { isActive: true });

  return {
    activeColumn,
    left: { filter: leftFilter, items: leftFiltered, index: leftEffectiveIndex, currentItem: leftCurrentItem },
    right: { filter: rightFilter, items: filteredRight, index: rightEffectiveIndex, currentItem: rightCurrentItem },
    selectedLeftKey,
    isSpecial,
    isOnCustomItem: rightActive && isOnVirtual,
    isOnLeftCustomItem: leftActive && isSpecial,
    currentRightIsCustom,
  };
}
