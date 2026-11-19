import { useState } from 'react';
import { useInput } from 'ink';
import { filterByFields, type FilterableItem } from '../../../components/pickers/filtering.js';
import { overlayStore } from '../../../stores/ui/overlay.js';
import { clampIndex } from '../../../utils/indexing.js';
import { escapeAction, handleKeyboardInput } from './keyboard.js';
import type { LeftColumnProps, RightColumnProps, TwoColumnNavState } from './types.js';
import { useColumnState } from './use-column-state.js';
import { useRightActions } from './use-right-actions.js';
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
  singlePane: boolean;
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
  const initialLeftIndex = leftProps.initialIndex ?? 0;
  const customRow = rightProps.customRow;
  const virtualCountOf = (left: L | undefined): number => {
    if (customRow === undefined) return 0;
    const applies = customRow.appliesTo;
    return applies === undefined || (left !== undefined && applies(left)) ? 1 : 0;
  };
  const resolveInitialRightIndex = rightProps.resolveInitialIndex;
  const onLeftChange = rightProps.onLeftChange ?? noop;
  const activationOf = rightProps.activationOf;

  const [activeColumn, setActiveColumn] = useState<'left' | 'right'>(initialColumn);
  const [selectedLeftKey, setSelectedLeftKey] = useState<string | null>(null);

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
  const virtualCount = virtualCountOf(leftCol.currentItem);
  const isRightItemCustom = virtualCount > 0 ? customRow?.isCustom : undefined;
  const onCustomRightOverlay = virtualCount > 0 ? customRow?.onSelect : undefined;
  const onDeleteRight = virtualCount > 0 ? customRow?.onDelete : undefined;
  const rightCol = useColumnState<R>({
    source: rightItems,
    filterFn: rightProps.filterBy ?? defaultRightFilter,
    getKey: rightProps.getKey,
    initialIndex: (rightProps.initialIndex ?? 0) + virtualCount,
    virtualCount,
  });

  const filteredRight: RightItemOrVirtual<R>[] =
    virtualCount > 0
      ? [{ id: CUSTOM_ROW_ID, isVirtual: true as const }, ...rightCol.items]
      : rightCol.items;
  const rightEffectiveIndex = clampIndex(rightCol.index, filteredRight.length);
  const rightCurrentItem = filteredRight[rightEffectiveIndex];

  const terminalPane = leftCol.currentItem ? terminalPaneOf?.(leftCol.currentItem) : undefined;
  const modelsVisible = !params.singlePane || activeColumn === 'right';
  const expandedOnScreen =
    modelsVisible && terminalPane === undefined && (rightProps.isExpanded ?? false);
  const isDisabled = leftCol.currentItem
    ? (isLeftItemDisabled?.(leftCol.currentItem) ?? false)
    : false;
  // Each key runs on the committed render: no render may keep the keys in a hidden list.
  if (activeColumn === 'right' && (isDisabled || terminalPane !== undefined)) {
    setActiveColumn('left');
    setSelectedLeftKey(null);
  }
  const rightActive = activeColumn === 'right';
  const isOnVirtual = !!rightCurrentItem && isVirtualCustomItem(rightCurrentItem);
  const currentRightIsCustom =
    rightActive &&
    !!rightCurrentItem &&
    isRealRightItem(rightCurrentItem) &&
    (isRightItemCustom?.(rightCurrentItem) ?? false);

  // The reset destination has to follow the highlighted left item: with a
  // synthesized Auto row at index 0, a constant reset would land on it and
  // confirming would silently rewrite an explicitly configured model. The
  // custom row it offsets past is the target's too, never the item being left.
  const resetRight = (left?: L) =>
    rightCol.reset((resolveInitialRightIndex?.(left) ?? 0) + virtualCountOf(left));

  // A column of notices and headers is a dead end: advancing into it parks the
  // cursor on rows whose Enter does nothing.
  const hasSelectableRight =
    virtualCount > 0 ||
    rightItems.some((item) => {
      const activation = activationOf?.(item) ?? 'confirm';
      return activation === 'confirm' || activation === 'expand';
    });

  const { moveRight, cycleRight, collapseRight, activateRight } = useRightActions({
    rightProps,
    leftCol,
    rightCol,
    filteredRight,
    setActiveColumn,
    onCustomRightOverlay,
    onConfirm,
    onRefresh: params.onRefresh,
    maxVisible: params.maxVisible,
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

  const moveLeft = (direction: 1 | -1) => {
    if (params.maxVisible <= 0 || leftCol.items.length === 0) return;
    setActiveColumn('left');
    setSelectedLeftKey(null);
    resetRight(leftCol.moveBy(direction));
  };

  const backToTools = () => {
    setActiveColumn('left');
    setSelectedLeftKey(null);
  };

  const isActive = overlayStore.use((s) => overlayAllowsPickerKeys(s.active));

  useInput(
    (input, key) =>
      handleKeyboardInput(input, key, {
        singlePane: params.singlePane,
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
        backToTools,
        setLeftFilter: leftCol.setFilter,
        setRightFilter: rightCol.setFilter,
        setLeftIndex: leftCol.setIndex,
        setRightIndex: rightCol.setIndex,
        resetRight,
        activateLeft,
        activateRight,
        cycleRight,
        isExpanded: expandedOnScreen,
        onCollapse: collapseRight,
      }),
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
    backToTools,
    hasSelectableRight,
    selectedLeftKey,
    terminalPane,
    isDisabled,
    escape: escapeAction({
      singlePane: params.singlePane,
      isExpanded: expandedOnScreen,
      leftActive: activeColumn === 'left',
      rightActive,
      leftFilter: leftCol.filter,
      rightFilter: rightCol.filter,
    }),
    isOnCustomItem: rightActive && isOnVirtual,
    currentRightIsCustom,
    wheelLeft: moveLeft,
    wheelRight: moveRight,
    clickLeft: activateLeft,
    clickRight: (index) => {
      // A row that steps its own value is a control, not a choice: a
      // click on it must not confirm the picker and dismiss it. A row that
      // only holds the space key is still a choice, so it stays clickable.
      if (cycleRight(index) === 'stepped') return;
      activateRight(index);
    },
  };
}
