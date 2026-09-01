import { useLayoutEffect, useState } from 'react';
import { useInput } from 'ink';
import { filterByFields, type FilterableItem } from '../../../components/pickers/filtering.js';
import { overlayStore } from '../../../stores/ui/overlay.js';
import { clampIndex } from '../../../utils/indexing.js';
import { assertNever } from '../../../utils/type-guards.js';
import { handleKeyboardInput } from './keyboard.js';
import type {
  CycleOutcome,
  LeftColumnProps,
  RightColumnProps,
  TwoColumnNavState,
} from './types.js';
import { useColumnState } from './use-column-state.js';
import {
  CUSTOM_ROW_ID,
  isRealRightItem,
  isVirtualCustomItem,
  type RightItemOrVirtual,
} from './virtual-items.js';
import { overlayAllowsPickerKeys } from '../../../core/navigation/types.js';

const noop = () => {};

interface UseTwoColumnStateParams<L extends FilterableItem, R extends { id: string }> {
  leftProps: LeftColumnProps<L>;
  rightProps: RightColumnProps<L, R>;
  initialColumn?: 'left' | 'right' | undefined;
  onConfirm: (left: L, right: R | null) => void;
  onCancel: () => void;
  onRefresh?: (() => void) | undefined;
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
  const { leftProps, rightProps, initialColumn = 'left', onConfirm, onCancel } = params;

  const leftItems = leftProps.items;
  const rightItems = rightProps.items;
  const leftGetKey = leftProps.getKey;
  const terminalPaneOf = leftProps.terminalPane;
  const isLeftItemDisabled = leftProps.isDisabled;
  const isRightItemCustom = rightProps.customRow?.isCustom;
  const initialLeftIndex = leftProps.initialIndex ?? 0;
  const allowCustomRight = !!rightProps.customRow;
  const virtualCount = allowCustomRight ? 1 : 0;
  const initialRightIndex = (rightProps.initialIndex ?? 0) + virtualCount;
  const resolveInitialRightIndex = rightProps.resolveInitialIndex;
  const onLeftChange = rightProps.onLeftChange ?? noop;
  const onCustomRightOverlay = rightProps.customRow?.onSelect;
  const onDeleteRight = rightProps.customRow?.onDelete;
  const activationOf = rightProps.activationOf;
  const onExpand = rightProps.onExpand;
  const onCollapse = rightProps.onCollapse;
  const onCycle = rightProps.onCycle;

  const initialLeftItem = leftItems[initialLeftIndex];
  const initialLeftTerminal =
    initialLeftItem === undefined ? undefined : terminalPaneOf?.(initialLeftItem);
  const initialLeftDisabled = initialLeftItem
    ? (isLeftItemDisabled?.(initialLeftItem) ?? false)
    : false;
  const effectiveInitialColumn =
    initialColumn === 'right' && (initialLeftDisabled || initialLeftTerminal !== undefined)
      ? 'left'
      : initialColumn;

  const [activeColumn, setActiveColumn] = useState<'left' | 'right'>(effectiveInitialColumn);
  const [selectedLeftKey, setSelectedLeftKey] = useState<string | null>(null);
  const [pendingExpand, setPendingExpand] = useState<string | null>(null);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);

  const leftCol = useColumnState<L>({
    source: leftItems,
    filterFn: leftProps.filterBy ?? defaultLeftFilter,
    getKey: leftGetKey,
    initialIndex: initialLeftIndex,
    compare: leftProps.compare,
    onCurrentItemChange: (item) => {
      if (item) onLeftChange(item);
    },
  });
  const rightCol = useColumnState<R>({
    source: rightItems,
    filterFn: rightProps.filterBy ?? defaultRightFilter,
    getKey: rightProps.getKey,
    initialIndex: initialRightIndex,
    virtualCount,
  });

  const filteredRight: RightItemOrVirtual<R>[] = allowCustomRight
    ? [{ id: CUSTOM_ROW_ID, isVirtual: true as const }, ...rightCol.items]
    : rightCol.items;
  const rightEffectiveIndex = clampIndex(rightCol.index, filteredRight.length);
  const rightCurrentItem = filteredRight[rightEffectiveIndex];

  const terminalPane = leftCol.currentItem ? terminalPaneOf?.(leftCol.currentItem) : undefined;
  const isDisabled = leftCol.currentItem
    ? (isLeftItemDisabled?.(leftCol.currentItem) ?? false)
    : false;
  const rightActive = activeColumn === 'right';
  const isOnVirtual = !!rightCurrentItem && isVirtualCustomItem(rightCurrentItem);
  const currentRightIsCustom =
    rightActive &&
    !!rightCurrentItem &&
    isRealRightItem(rightCurrentItem) &&
    (isRightItemCustom?.(rightCurrentItem) ?? false);

  // The reset destination has to follow the highlighted left item: with a
  // synthesized Auto row at index 0, a constant reset would land on it and
  // confirming would silently rewrite an explicitly configured model.
  const resetRight = (left?: L) =>
    rightCol.reset((resolveInitialRightIndex?.(left) ?? 0) + virtualCount);

  // A column of notices and headers is a dead end: advancing into it parks the
  // cursor on rows whose Enter does nothing.
  const hasSelectableRight =
    virtualCount > 0 ||
    rightItems.some((item) => {
      const activation = activationOf?.(item) ?? 'confirm';
      return activation === 'confirm' || activation === 'expand';
    });

  const rightIndexOfKey = (key: string) =>
    filteredRight.findIndex((row) => isRealRightItem(row) && rightProps.getKey(row) === key);

  // The expansion reaches this hook as props on a later render, so the cursor
  // move waits for it: an index computed when the key was pressed is measured
  // against the pre-expansion list and clamps back when the parent was last.
  useLayoutEffect(() => {
    if (pendingExpand === null) return;
    if (!(rightProps.isExpanded ?? false)) {
      setPendingExpand(null);
      return;
    }
    const at = rightIndexOfKey(pendingExpand);
    setPendingExpand(null);
    if (at >= 0 && at + 1 < filteredRight.length) rightCol.setIndex(at + 1);
  });

  const activateLeft = (index: number) => {
    if (params.maxVisible <= 0) return;
    const item = leftCol.items[index];
    if (!item) return;
    leftCol.setIndex(index);
    resetRight(item);
    if (isLeftItemDisabled?.(item) ?? false) return;
    if (terminalPaneOf?.(item) !== undefined) {
      onConfirm(item, null);
      return;
    }
    setSelectedLeftKey(leftGetKey(item));
    if (hasSelectableRight) setActiveColumn('right');
  };

  const cycleRight = (index: number): CycleOutcome => {
    if (params.maxVisible <= 0) return 'none';
    const item = filteredRight[index];
    if (item === undefined || !isRealRightItem(item)) return 'none';
    const outcome = onCycle?.(item) ?? 'none';
    if (outcome === 'none') return 'none';
    rightCol.setIndex(index);
    setActiveColumn('right');
    return outcome;
  };

  // Collapsing takes the rows under the cursor out of the list, so the highlight
  // goes back to the row that opened them instead of to whatever slid up into it.
  const collapseRight = () => {
    const at = expandedKey === null ? -1 : rightIndexOfKey(expandedKey);
    if (at >= 0) rightCol.setIndex(at);
    setExpandedKey(null);
    onCollapse?.();
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
    const activation = activationOf?.(item) ?? 'confirm';
    switch (activation) {
      case 'expand': {
        const key = rightProps.getKey(item);
        onExpand?.(item);
        setPendingExpand(key);
        setExpandedKey(key);
        return;
      }
      case 'collapse':
        collapseRight();
        return;
      case 'refresh':
        params.onRefresh?.();
        return;
      case 'none':
        return;
      case 'confirm': {
        const leftItem = leftCol.items[leftCol.effectiveIndex];
        if (leftItem) onConfirm(leftItem, item);
        return;
      }
      default:
        return assertNever(activation);
    }
  };

  const isActive = overlayStore.use((s) => overlayAllowsPickerKeys(s.active));

  useInput(
    (input, key) => {
      handleKeyboardInput(input, key, {
        leftActive: activeColumn === 'left',
        rightActive,
        isTerminal: terminalPane !== undefined,
        isDisabled,
        hasSelectableRight,
        currentRightIsCustom,
        leftCurrentItem: leftCol.currentItem,
        leftFiltered: leftCol.items,
        filteredRight,
        leftFilter: leftCol.filter,
        rightFilter: rightCol.filter,
        rightVirtualCount: virtualCount,
        leftEffectiveIndex: leftCol.effectiveIndex,
        rightEffectiveIndex,
        isRightItemCustom,
        onDeleteRight,
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
        activateLeft,
        activateRight,
        cycleRight,
        isExpanded: rightProps.isExpanded ?? false,
        onCollapse: collapseRight,
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
    terminalPane,
    isOnCustomItem: rightActive && isOnVirtual,
    currentRightIsCustom,
    activateLeft,
    activateRight,
    cycleRight,
  };
}
