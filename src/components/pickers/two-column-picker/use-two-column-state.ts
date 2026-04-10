import { useEffect, useEffectEvent, useState, type ReactNode } from 'react';
import { useInput } from 'ink';
import { filterByFields, type FilterableItem } from '../picker-utils.js';
import { handleKeyboardInput } from './two-column-keyboard.js';

export interface LeftColumnProps<L> {
  items: L[];
  label?: string | undefined;
  filterBy?: ((item: L, query: string) => boolean) | undefined;
  renderRow: (item: L, meta: { isCursor: boolean; isSelected: boolean; maxWidth: number }) => ReactNode;
  getKey: (item: L) => string;
  isSpecial?: ((item: L) => boolean) | undefined;
  isDisabled?: ((item: L) => boolean) | undefined;
  initialIndex?: number | undefined;
  specialHelp?: ReactNode | undefined;
}

export interface CustomRowOptions<L, R> {
  onSelect: (left: L) => void;
  isCustom?: ((item: R) => boolean) | undefined;
  onDelete?: ((item: R) => void) | undefined;
}

export interface RightColumnProps<L, R> {
  items: R[];
  label?: string | undefined;
  filterBy?: ((item: R, query: string) => boolean) | undefined;
  renderRow: (item: R, meta: { isCursor: boolean; maxWidth: number }) => ReactNode;
  getKey: (item: R) => string;
  placeholder?: ReactNode | undefined;
  customRow?: CustomRowOptions<L, R> | undefined;
  onLeftChange?: ((item: L) => void) | undefined;
  initialIndex?: number | undefined;
}

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

interface UseTwoColumnStateParams<L extends FilterableItem, R extends { id: string }> {
  leftProps: LeftColumnProps<L>;
  rightProps: RightColumnProps<L, R>;
  initialColumn?: 'left' | 'right' | undefined;
  onConfirm: (left: L, right: R | null) => void;
  onCancel: () => void;
}

function defaultLeftFilter<L extends FilterableItem>(item: L, query: string): boolean {
  return filterByFields(item, query, ['id', 'displayName']);
}

function defaultRightFilter<R extends { id: string }>(item: R, query: string): boolean {
  return filterByFields(item, query, ['id']);
}

const clampIndex = (index: number, length: number) => Math.min(index, Math.max(0, length - 1));

export function useTwoColumnState<L extends FilterableItem, R extends { id: string }>(
  params: UseTwoColumnStateParams<L, R>,
): TwoColumnNavState<L, R> {
  const { leftProps, rightProps, initialColumn = 'left', onConfirm, onCancel } = params;

  const leftItems = leftProps.items;
  const rightItems = rightProps.items;
  const leftGetKey = leftProps.getKey;
  const leftFilterFn = leftProps.filterBy;
  const rightFilterFn = rightProps.filterBy;
  const isLeftItemSpecial = leftProps.isSpecial;
  const isLeftItemDisabled = leftProps.isDisabled;
  const isRightItemCustom = rightProps.customRow?.isCustom;
  const initialLeftIndex = leftProps.initialIndex;
  const initialRightIndex = rightProps.initialIndex;
  const allowCustomRight = !!rightProps.customRow;
  const rightPlaceholder = rightProps.placeholder;
  const onLeftChange = rightProps.onLeftChange ?? (() => {});
  const onCustomRightOverlay = rightProps.customRow?.onSelect;
  const onDeleteRight = rightProps.customRow?.onDelete;

  const initialLeftItem = leftItems[initialLeftIndex ?? 0];
  const initialLeftDisabled = initialLeftItem ? (isLeftItemDisabled?.(initialLeftItem) ?? false) : false;
  const effectiveInitialColumn = initialColumn === 'right' && initialLeftDisabled ? 'left' : initialColumn;

  const [activeColumn, setActiveColumn] = useState<'left' | 'right'>(effectiveInitialColumn);
  const [selectedLeftKey, setSelectedLeftKey] = useState<string | null>(null);
  const [leftFilter, setLeftFilter] = useState('');
  const [rightFilter, setRightFilter] = useState('');
  const [leftIndex, setLeftIndex] = useState(initialLeftIndex ?? 0);
  const [rightIndex, setRightIndex] = useState(initialRightIndex ?? 0);

  const resetRight = () => { setRightIndex(0); setRightFilter(''); };

  const leftFilterFnEff = leftFilterFn ?? defaultLeftFilter;
  const rightFilterFnEff = rightFilterFn ?? defaultRightFilter;

  const leftFiltered = leftFilter ? leftItems.filter((it) => leftFilterFnEff(it, leftFilter)) : leftItems;
  const rightFiltered = rightFilter ? rightItems.filter((it) => rightFilterFnEff(it, rightFilter)) : rightItems;

  const filteredRight: RightItemOrVirtual<R>[] = allowCustomRight
    ? [{ id: CUSTOM_ROW_ID, isVirtual: true as const }, ...rightFiltered]
    : rightFiltered;

  const leftEffectiveIndex = clampIndex(leftIndex, leftFiltered.length);
  const rightEffectiveIndex = clampIndex(rightIndex, filteredRight.length);
  const leftCurrentItem = leftFiltered[leftEffectiveIndex];
  const rightCurrentItem = filteredRight[rightEffectiveIndex];

  const isSpecial = leftCurrentItem ? (isLeftItemSpecial?.(leftCurrentItem) ?? false) : false;
  const isDisabled = leftCurrentItem ? (isLeftItemDisabled?.(leftCurrentItem) ?? false) : false;
  const leftActive = activeColumn === 'left';
  const rightActive = activeColumn === 'right';
  const isOnVirtual = !!rightCurrentItem && isVirtualCustomItem(rightCurrentItem);
  const currentRightIsCustom = rightActive && !!rightCurrentItem && !isOnVirtual
    && (isRightItemCustom?.(rightCurrentItem as R) ?? false);

  // Track selected left by key: firing the effect only when the selection
  // key actually changes, not on every render/reference change.
  const currentLeftKey = leftCurrentItem ? leftGetKey(leftCurrentItem) : null;
  const syncLeftItem = useEffectEvent(() => {
    if (!leftCurrentItem) return;
    onLeftChange(leftCurrentItem);
  });

  useEffect(() => {
    if (currentLeftKey === null) return;
    syncLeftItem();
  }, [currentLeftKey]);

  useInput((input, key) => {
    handleKeyboardInput(input, key, {
      leftActive, rightActive, isSpecial, isDisabled, isOnVirtual, currentRightIsCustom,
      leftCurrentItem, leftFiltered, filteredRight, leftEffectiveIndex, rightEffectiveIndex,
      rightItems, rightPlaceholder, leftGetKey, isRightItemCustom, onDeleteRight,
      onCustomRightOverlay, onConfirm, onCancel,
      setActiveColumn, setSelectedLeftKey, setLeftFilter, setRightFilter,
      setLeftIndex, setRightIndex, resetRight,
    });
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
