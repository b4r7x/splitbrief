import { useState, type ReactNode } from 'react';
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
  resolveInitialIndex?: ((left: L | undefined) => number | undefined) | undefined;
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
  activateLeft: (index: number) => void;
  activateRight: (index: number) => void;
}

interface UseTwoColumnStateParams<L extends FilterableItem, R extends { id: string }> {
  leftProps: LeftColumnProps<L>;
  rightProps: RightColumnProps<L, R>;
  initialColumn?: 'left' | 'right' | undefined;
  onConfirm: (left: L, right: R | null) => void;
  onCancel: () => void;
  onRefresh?: (() => void) | undefined;
  onDisabledSelect?: ((item: L) => void) | undefined;
  maxVisible: number;
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
  const {
    leftProps,
    rightProps,
    initialColumn = 'left',
    onConfirm,
    onCancel,
    onDisabledSelect,
  } = params;

  const leftItems = leftProps.items;
  const rightItems = rightProps.items;
  const leftGetKey = leftProps.getKey;
  const isLeftItemSpecial = leftProps.isSpecial;
  const isLeftItemDisabled = leftProps.isDisabled;
  const isRightItemCustom = rightProps.customRow?.isCustom;
  const initialLeftIndex = leftProps.initialIndex ?? 0;
  const allowCustomRight = !!rightProps.customRow;
  const defaultRightIndex = allowCustomRight ? 1 : 0;
  const initialRightIndex = rightProps.initialIndex ?? defaultRightIndex;
  const resolveInitialRightIndex = rightProps.resolveInitialIndex;
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
    getKey: leftGetKey,
    initialIndex: initialLeftIndex,
    onCurrentItemChange: (item) => {
      if (item) onLeftChange(item);
    },
  });
  const rightCol = useColumnState<R>({
    source: rightItems,
    filterFn: rightProps.filterBy ?? defaultRightFilter,
    getKey: rightProps.getKey,
    initialIndex: initialRightIndex,
    virtualCount: allowCustomRight ? 1 : 0,
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

  // The reset destination has to follow the highlighted left item: with a
  // synthesized Auto row at index 0, a constant reset would land on it and
  // confirming would silently rewrite an explicitly configured model.
  const resetRight = (left?: L) =>
    rightCol.reset(resolveInitialRightIndex?.(left) ?? defaultRightIndex);

  const activateLeft = (index: number) => {
    if (params.maxVisible <= 0) return;
    const item = leftCol.items[index];
    if (!item) return;
    leftCol.setIndex(index);
    resetRight(item);
    setActiveColumn('left');
    const disabled = isLeftItemDisabled?.(item) ?? false;
    const special = isLeftItemSpecial?.(item) ?? false;
    if (!disabled && special) onConfirm(item, null);
  };

  const activateRight = (index: number) => {
    if (params.maxVisible <= 0) return;
    const item = filteredRight[index];
    if (!item) return;
    rightCol.setIndex(index);
    setActiveColumn('right');
    if (isVirtualCustomItem(item)) {
      if (onCustomRightOverlay && leftCol.currentItem) onCustomRightOverlay(leftCol.currentItem);
      return;
    }
    if (!isRealRightItem(item)) return;
    const leftItem = leftCol.items[leftCol.effectiveIndex];
    if (leftItem) onConfirm(leftItem, item);
  };

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
        onDisabledSelect,
        leftFiltered: leftCol.items,
        filteredRight,
        leftFilter: leftCol.filter,
        rightFilter: rightCol.filter,
        rightVirtualCount: allowCustomRight ? 1 : 0,
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
        maxVisible: params.maxVisible,
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
    activateLeft,
    activateRight,
  };
}
