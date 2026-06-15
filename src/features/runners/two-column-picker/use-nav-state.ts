import { useEffect, useEffectEvent, useState, type ReactNode } from 'react';
import { useInput } from 'ink';
import { filterByFields, type FilterableItem } from '../../../components/pickers/filtering.js';
import { overlayStore } from '../../../stores/ui/overlay.js';
import { clampIndex } from '../../../utils/indexing.js';
import { handleKeyboardInput } from './keyboard.js';
import { useColumnState } from './use-column-state.js';
import {
  CUSTOM_ROW_ID,
  isRealRightItem,
  isVirtualCustomItem,
  type RightItemOrVirtual,
} from './virtual-items.js';

const noop = () => {};

export interface LeftColumnProps<L> {
  items: L[];
  label?: string | undefined;
  filterBy?: ((item: L, query: string) => boolean) | undefined;
  renderRow: (
    item: L,
    meta: { isCursor: boolean; isSelected: boolean; maxWidth: number },
  ) => ReactNode;
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
  onRefresh?: (() => void) | undefined;
}

function defaultLeftFilter<L extends FilterableItem>(item: L, query: string): boolean {
  return filterByFields(item, query, ['id', 'displayName']);
}

function defaultRightFilter<R extends { id: string }>(item: R, query: string): boolean {
  return filterByFields(item, query, ['id']);
}

export function useTwoColumnState<L extends FilterableItem, R extends { id: string }>(
  params: UseTwoColumnStateParams<L, R>,
): TwoColumnNavState<L, R> {
  const { leftProps, rightProps, initialColumn = 'left', onConfirm, onCancel } = params;

  const leftItems = leftProps.items;
  const rightItems = rightProps.items;
  const leftGetKey = leftProps.getKey;
  const isLeftItemSpecial = leftProps.isSpecial;
  const isLeftItemDisabled = leftProps.isDisabled;
  const isRightItemCustom = rightProps.customRow?.isCustom;
  const initialLeftIndex = leftProps.initialIndex ?? 0;
  const allowCustomRight = !!rightProps.customRow;
  const initialRightIndex = rightProps.initialIndex ?? (allowCustomRight ? 1 : 0);
  const rightPlaceholder = rightProps.placeholder;
  const onLeftChange = rightProps.onLeftChange ?? noop;
  const onCustomRightOverlay = rightProps.customRow?.onSelect;
  const onDeleteRight = rightProps.customRow?.onDelete;

  const initialLeftItem = leftItems[initialLeftIndex];
  const initialLeftDisabled = initialLeftItem
    ? (isLeftItemDisabled?.(initialLeftItem) ?? false)
    : false;
  const effectiveInitialColumn =
    initialColumn === 'right' && initialLeftDisabled ? 'left' : initialColumn;

  const [activeColumn, setActiveColumn] = useState<'left' | 'right'>(effectiveInitialColumn);
  const [selectedLeftKey, setSelectedLeftKey] = useState<string | null>(null);

  const leftCol = useColumnState<L>({
    source: leftItems,
    filterFn: leftProps.filterBy ?? defaultLeftFilter,
    initialIndex: initialLeftIndex,
  });
  const rightCol = useColumnState<R>({
    source: rightItems,
    filterFn: rightProps.filterBy ?? defaultRightFilter,
    initialIndex: initialRightIndex,
  });

  const filteredRight: RightItemOrVirtual<R>[] = allowCustomRight
    ? [{ id: CUSTOM_ROW_ID, isVirtual: true as const }, ...rightCol.items]
    : rightCol.items;
  const rightEffectiveIndex = clampIndex(rightCol.index, filteredRight.length);
  const rightCurrentItem = filteredRight[rightEffectiveIndex];

  const isSpecial = leftCol.currentItem
    ? (isLeftItemSpecial?.(leftCol.currentItem) ?? false)
    : false;
  const isDisabled = leftCol.currentItem
    ? (isLeftItemDisabled?.(leftCol.currentItem) ?? false)
    : false;
  const leftActive = activeColumn === 'left';
  const rightActive = activeColumn === 'right';
  const isOnVirtual = !!rightCurrentItem && isVirtualCustomItem(rightCurrentItem);
  const currentRightIsCustom =
    rightActive &&
    !!rightCurrentItem &&
    !isOnVirtual &&
    isRealRightItem(rightCurrentItem) &&
    (isRightItemCustom?.(rightCurrentItem) ?? false);

  const currentLeftKey = leftCol.currentItem ? leftGetKey(leftCol.currentItem) : null;
  const syncLeftItem = useEffectEvent(() => {
    if (!leftCol.currentItem) return;
    onLeftChange(leftCol.currentItem);
  });

  useEffect(() => {
    if (currentLeftKey === null) return;
    syncLeftItem();
  }, [currentLeftKey]);

  const resetRight = () => rightCol.reset(allowCustomRight ? 1 : 0);

  const isActive = overlayStore.use(
    (s) =>
      s.active === 'none' || s.active === 'planner-picker' || s.active === 'implementer-picker',
  );

  useInput(
    (input, key) => {
      handleKeyboardInput(input, key, {
        leftActive,
        rightActive,
        isSpecial,
        isDisabled,
        isOnVirtual,
        currentRightIsCustom,
        leftCurrentItem: leftCol.currentItem,
        leftFiltered: leftCol.items,
        filteredRight,
        leftEffectiveIndex: leftCol.effectiveIndex,
        rightEffectiveIndex,
        rightItems,
        rightPlaceholder,
        leftGetKey,
        isRightItemCustom,
        onDeleteRight,
        onCustomRightOverlay,
        onConfirm,
        onCancel,
        onRefresh: params.onRefresh,
        setActiveColumn,
        setSelectedLeftKey,
        setLeftFilter: leftCol.setFilter,
        setRightFilter: rightCol.setFilter,
        setLeftIndex: leftCol.setIndex,
        setRightIndex: rightCol.setIndex,
        resetRight,
      });
    },
    { isActive },
  );

  return {
    activeColumn,
    left: {
      filter: leftCol.filter,
      items: leftCol.items,
      index: leftCol.effectiveIndex,
      currentItem: leftCol.currentItem,
    },
    right: {
      filter: rightCol.filter,
      items: filteredRight,
      index: rightEffectiveIndex,
      currentItem: rightCurrentItem,
    },
    selectedLeftKey,
    isSpecial,
    isOnCustomItem: rightActive && isOnVirtual,
    isOnLeftCustomItem: leftActive && isSpecial,
    currentRightIsCustom,
  };
}
