import { useLayoutEffect, useState } from 'react';
import { assertNever } from '../../../utils/type-guards.js';
import type { CycleOutcome, RightColumnProps } from './types.js';
import type { ColumnStateHook } from './use-column-state.js';
import { isRealRightItem, isVirtualCustomItem, type RightItemOrVirtual } from './virtual-items.js';

interface RightActionsInput<L, R extends { id: string }> {
  rightProps: RightColumnProps<L, R>;
  leftCol: ColumnStateHook<L>;
  rightCol: ColumnStateHook<R>;
  filteredRight: RightItemOrVirtual<R>[];
  setActiveColumn: (column: 'left' | 'right') => void;
  onCustomRightOverlay: ((left: L) => void) | undefined;
  onConfirm: (left: L, right: R | null) => void;
  onRefresh: (() => void) | undefined;
  maxVisible: number;
}

/** The actions on the rows of the right column, with the expansion they open and close. */
export function useRightActions<L, R extends { id: string }>(input: RightActionsInput<L, R>) {
  const {
    rightProps,
    leftCol,
    rightCol,
    filteredRight,
    setActiveColumn,
    onCustomRightOverlay,
    onConfirm,
    onRefresh,
    maxVisible,
  } = input;
  const { activationOf, onExpand, onCollapse, onCycle } = rightProps;

  const [pendingExpand, setPendingExpand] = useState<string | null>(null);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);

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

  const moveRight = (direction: 1 | -1) => {
    if (maxVisible <= 0 || filteredRight.length === 0) return;
    setActiveColumn('right');
    rightCol.moveBy(direction);
  };

  const cycleRight = (index: number): CycleOutcome => {
    if (maxVisible <= 0) return 'none';
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
    if (maxVisible <= 0) return;
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
        onRefresh?.();
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

  return { moveRight, cycleRight, collapseRight, activateRight };
}
