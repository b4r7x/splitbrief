import { useLayoutEffect, useState, type ReactNode } from 'react';
import { useInput } from 'ink';
import { filterByFields, type FilterableItem } from '../../../components/pickers/filtering.js';
import { overlayStore } from '../../../stores/ui/overlay.js';
import { clampIndex } from '../../../utils/indexing.js';
import { assertNever } from '../../../utils/type-guards.js';
import { handleKeyboardInput } from './keyboard.js';
import { useColumnState } from './use-column-state.js';
import {
  CUSTOM_ROW_ID,
  isRealRightItem,
  isVirtualCustomItem,
  type RightItemOrVirtual,
} from './virtual-items.js';
import { overlayAllowsPickerKeys } from '../../../core/navigation/types.js';

const noop = () => {};

/**
 * A left row that answers for itself: the right column becomes a read-only card
 * and Enter commits the row instead of advancing into an empty model column.
 */
export interface TerminalPane {
  label: string;
  /** The verb the hint promises for Enter on this row. */
  verb: string;
  lines: string[];
}

/** What Enter does on the highlighted right row. */
export type RightActivation = 'confirm' | 'expand' | 'collapse' | 'refresh' | 'none';

/**
 * What a right row does with a value-stepping gesture. `stepped` marks the row as
 * the value control: it takes the space key, and a click on it steps instead of
 * activating. `held` takes the key without owning the click, which is how a row
 * inside an expansion refuses to collapse it.
 */
export type CycleOutcome = 'stepped' | 'held' | 'none';

export interface RightSectionProps<R> {
  by: (item: R) => string;
  headerFor?: ((section: string) => boolean) | undefined;
}

export interface LeftColumnProps<L> {
  items: L[];
  label?: string | undefined;
  filterBy?: ((item: L, query: string) => boolean) | undefined;
  renderRow: (
    item: L,
    meta: { isCursor: boolean; isSelected: boolean; maxWidth: number },
  ) => ReactNode;
  getKey: (item: L) => string;
  terminalPane?: ((item: L) => TerminalPane | undefined) | undefined;
  isDisabled?: ((item: L) => boolean) | undefined;
  initialIndex?: number | undefined;
  compare?: ((a: L, b: L) => number) | undefined;
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
  /** Index into `items`; the display offset for pinned virtual rows is added here. */
  initialIndex?: number | undefined;
  resolveInitialIndex?: ((left: L | undefined) => number | undefined) | undefined;
  section?: RightSectionProps<R> | undefined;
  activationOf?: ((item: R) => RightActivation) | undefined;
  onExpand?: ((item: R) => void) | undefined;
  onCollapse?: (() => void) | undefined;
  onCycle?: ((item: R) => CycleOutcome) | undefined;
  isExpanded?: boolean | undefined;
  /** Replaces the expanded-column Enter verb for the highlighted row (`⏎ choose route` otherwise). */
  expandedHint?: ((item: R | undefined) => string | undefined) | undefined;
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
  terminalPane: TerminalPane | undefined;
  isOnCustomItem: boolean;
  currentRightIsCustom: boolean;
  activateLeft: (index: number) => void;
  activateRight: (index: number) => void;
  cycleRight: (index: number) => CycleOutcome;
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
    if (isLeftItemDisabled?.(item) ?? false) {
      onDisabledSelect?.(item);
      return;
    }
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
