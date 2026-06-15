import type { ReactNode } from 'react';
import type { FilterableItem } from '../../../components/pickers/filtering.js';
import { isVirtualCustomItem, type RightItemOrVirtual } from './virtual-items.js';

function stepIndex<T>(items: T[], from: number, direction: 1 | -1): number {
  if (items.length === 0) return from;
  return (from + direction + items.length) % items.length;
}

export interface KeyboardContext<L extends FilterableItem, R extends { id: string }> {
  leftActive: boolean;
  rightActive: boolean;
  isSpecial: boolean;
  isDisabled: boolean;
  isOnVirtual: boolean;
  currentRightIsCustom: boolean;
  leftCurrentItem: L | undefined;
  leftFiltered: L[];
  filteredRight: RightItemOrVirtual<R>[];
  leftEffectiveIndex: number;
  rightEffectiveIndex: number;
  rightItems: R[];
  rightPlaceholder: ReactNode;
  leftGetKey: (item: L) => string;
  isRightItemCustom: ((item: R) => boolean) | undefined;
  onDeleteRight: ((item: R) => void) | undefined;
  onCustomRightOverlay: ((item: L) => void) | undefined;
  onConfirm: (left: L, right: R | null) => void;
  onCancel: () => void;
  onRefresh?: (() => void) | undefined;
  setActiveColumn: (col: 'left' | 'right') => void;
  setSelectedLeftKey: (key: string | null) => void;
  setLeftFilter: (fn: (prev: string) => string) => void;
  setRightFilter: (fn: (prev: string) => string) => void;
  setLeftIndex: (index: number) => void;
  setRightIndex: (index: number) => void;
  resetRight: () => void;
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
    shift: boolean;
    tab: boolean;
  },
  ctx: KeyboardContext<L, R>,
): void {
  if (key.escape) {
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
    if (ctx.onRefresh) {
      ctx.onRefresh();
    }
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
      !ctx.isSpecial &&
      (ctx.rightItems.length > 0 || ctx.rightPlaceholder)
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
      ctx.setLeftIndex(next);
      ctx.resetRight();
    } else {
      if (ctx.filteredRight.length === 0) return;
      const next = stepIndex(ctx.filteredRight, ctx.rightEffectiveIndex, direction);
      ctx.setRightIndex(next);
    }
    return;
  }

  if (key.return) {
    if (ctx.leftActive) {
      if (!ctx.leftCurrentItem || ctx.isDisabled) return;
      if (ctx.isSpecial) {
        ctx.onConfirm(ctx.leftCurrentItem, null);
        return;
      }
      ctx.setSelectedLeftKey(ctx.leftGetKey(ctx.leftCurrentItem));
      if (ctx.rightItems.length > 0 || Boolean(ctx.rightPlaceholder)) ctx.setActiveColumn('right');
      return;
    }
    if (ctx.isOnVirtual) {
      if (ctx.onCustomRightOverlay && ctx.leftCurrentItem)
        ctx.onCustomRightOverlay(ctx.leftCurrentItem);
      return;
    }
    const rc = ctx.filteredRight[ctx.rightEffectiveIndex];
    const ri = rc && !isVirtualCustomItem(rc) ? rc : null;
    const leftItem = ctx.leftFiltered[ctx.leftEffectiveIndex];
    if (leftItem) ctx.onConfirm(leftItem, ri);
    return;
  }

  if (key.backspace || key.delete) {
    if (ctx.leftActive && !ctx.isSpecial) {
      ctx.setLeftFilter((prev) => prev.slice(0, -1));
      ctx.setLeftIndex(0);
      ctx.resetRight();
    } else if (ctx.rightActive) {
      ctx.setRightFilter((prev) => prev.slice(0, -1));
      ctx.setRightIndex(0);
    }
    return;
  }

  if (input && !key.ctrl && !key.meta) {
    if (ctx.leftActive && !ctx.isSpecial) {
      ctx.setLeftFilter((prev) => prev + input);
      ctx.setLeftIndex(0);
      ctx.resetRight();
    } else if (ctx.rightActive) {
      ctx.setRightFilter((prev) => prev + input);
      ctx.setRightIndex(0);
    }
  }
}
