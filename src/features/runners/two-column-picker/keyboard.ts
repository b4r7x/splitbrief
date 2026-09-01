import type { FilterableItem } from '../../../components/pickers/filtering.js';
import type { CycleOutcome } from './types.js';
import { isVirtualCustomItem, type RightItemOrVirtual } from './virtual-items.js';

function stepIndex<T>(items: T[], from: number, direction: 1 | -1): number {
  if (items.length === 0) return from;
  return (from + direction + items.length) % items.length;
}

export interface KeyboardContext<L extends FilterableItem, R extends { id: string }> {
  leftActive: boolean;
  rightActive: boolean;
  /** The highlighted left row answers for itself: Enter commits, → is inert. */
  isTerminal: boolean;
  isDisabled: boolean;
  /** The right column holds at least one row Enter can act on. */
  hasSelectableRight: boolean;
  currentRightIsCustom: boolean;
  leftCurrentItem: L | undefined;
  leftFiltered: L[];
  filteredRight: RightItemOrVirtual<R>[];
  leftFilter: string;
  rightFilter: string;
  /** Virtual rows pinned ahead of the right matches; the first real match sits at this index. */
  rightVirtualCount: number;
  leftEffectiveIndex: number;
  rightEffectiveIndex: number;
  isRightItemCustom: ((item: R) => boolean) | undefined;
  onDeleteRight: ((item: R) => void) | undefined;
  onCancel: () => void;
  onRefresh?: (() => void) | undefined;
  maxVisible: number;
  setActiveColumn: (col: 'left' | 'right') => void;
  setSelectedLeftKey: (key: string | null) => void;
  setLeftFilter: (fn: (prev: string) => string) => void;
  setRightFilter: (fn: (prev: string) => string) => void;
  /** Returns the left item the cursor lands on, so the right column can reset against it. */
  setLeftIndex: (index: number) => L | undefined;
  setRightIndex: (index: number) => void;
  resetRight: (left?: L | undefined) => void;
  /** The two activation paths; Enter never re-implements either. */
  activateLeft: (index: number) => void;
  activateRight: (index: number) => void;
  /** Steps the right row in place; `none` leaves the key to the query. */
  cycleRight: (index: number) => CycleOutcome;
  isExpanded: boolean;
  onCollapse?: (() => void) | undefined;
}

export function handleKeyboardInput<L extends FilterableItem, R extends { id: string }>(
  input: string,
  key: {
    escape: boolean;
    ctrl: boolean;
    meta: boolean;
    leftArrow: boolean;
    rightArrow: boolean;
    upArrow: boolean;
    downArrow: boolean;
    return: boolean;
    backspace: boolean;
    delete: boolean;
    tab: boolean;
  },
  ctx: KeyboardContext<L, R>,
): void {
  if (key.escape) {
    if (ctx.leftActive && ctx.leftFilter !== '') {
      ctx.setLeftFilter(() => '');
      ctx.resetRight(ctx.setLeftIndex(0));
      return;
    }
    if (ctx.rightActive && ctx.rightFilter !== '') {
      ctx.setRightFilter(() => '');
      ctx.setRightIndex(ctx.rightVirtualCount);
      return;
    }
    if (ctx.isExpanded) {
      ctx.onCollapse?.();
      return;
    }
    ctx.onCancel();
    return;
  }

  if (key.ctrl && input === 'd') {
    if (ctx.rightActive && ctx.currentRightIsCustom && ctx.onDeleteRight) {
      const item = ctx.filteredRight[ctx.rightEffectiveIndex];
      if (item && !isVirtualCustomItem(item) && ctx.isRightItemCustom?.(item)) {
        ctx.onDeleteRight(item);
      }
    }
    return;
  }

  if (key.ctrl && input === 'r') {
    ctx.onRefresh?.();
    return;
  }

  if (key.leftArrow) {
    if (ctx.rightActive) {
      ctx.setActiveColumn('left');
      ctx.setSelectedLeftKey(null);
    }
    return;
  }

  if (key.rightArrow) {
    if (
      ctx.leftActive &&
      ctx.leftCurrentItem &&
      !ctx.isDisabled &&
      !ctx.isTerminal &&
      ctx.hasSelectableRight
    ) {
      ctx.setActiveColumn('right');
    }
    return;
  }

  if (key.upArrow || key.downArrow) {
    const direction: 1 | -1 = key.upArrow ? -1 : 1;
    if (ctx.leftActive) {
      if (ctx.leftFiltered.length === 0) return;
      const next = stepIndex(ctx.leftFiltered, ctx.leftEffectiveIndex, direction);
      ctx.resetRight(ctx.setLeftIndex(next));
    } else {
      if (ctx.filteredRight.length === 0) return;
      const next = stepIndex(ctx.filteredRight, ctx.rightEffectiveIndex, direction);
      ctx.setRightIndex(next);
    }
    return;
  }

  if (key.return) {
    if (ctx.maxVisible <= 0) return;
    if (ctx.leftActive) {
      ctx.activateLeft(ctx.leftEffectiveIndex);
      return;
    }
    ctx.activateRight(ctx.rightEffectiveIndex);
    return;
  }

  // Type-anywhere: every printable key edits the focused column's query, no matter
  // which row the cursor sits on — including the pinned custom-command launcher —
  // and the cursor then lands on the first visible match. An expanded model
  // collapses first, or the query would filter a list the user cannot see whole.
  if (key.backspace || key.delete) {
    if (ctx.leftActive) {
      ctx.setLeftFilter((prev) => prev.slice(0, -1));
      ctx.resetRight(ctx.setLeftIndex(0));
    } else if (ctx.rightActive) {
      ctx.setRightFilter((prev) => prev.slice(0, -1));
      ctx.setRightIndex(ctx.rightVirtualCount);
    }
    return;
  }

  if (input && !key.ctrl && !key.meta && !key.tab) {
    if (input === ' ' && ctx.rightActive && ctx.cycleRight(ctx.rightEffectiveIndex) !== 'none') {
      return;
    }
    if (ctx.isExpanded) ctx.onCollapse?.();
    if (ctx.leftActive) {
      ctx.setLeftFilter((prev) => prev + input);
      ctx.resetRight(ctx.setLeftIndex(0));
    } else if (ctx.rightActive) {
      ctx.setRightFilter((prev) => prev + input);
      ctx.setRightIndex(ctx.rightVirtualCount);
    }
  }
}
