import { clamp } from '../../utils/math.js';
import { assertNever } from '../../utils/type-guards.js';

export type ScrollKeyAction = 'line-up' | 'line-down' | 'page-up' | 'page-down' | 'top' | 'bottom';

export type ScrollLineKeyMode = 'none' | 'shifted' | 'plain';

export interface ScrollKeyLike {
  upArrow?: boolean | undefined;
  downArrow?: boolean | undefined;
  pageUp?: boolean | undefined;
  pageDown?: boolean | undefined;
  home?: boolean | undefined;
  end?: boolean | undefined;
  ctrl?: boolean | undefined;
  shift?: boolean | undefined;
  meta?: boolean | undefined;
  super?: boolean | undefined;
  hyper?: boolean | undefined;
}

export interface ResolveScrollKeyInput {
  input: string;
  key: ScrollKeyLike;
  lineKeys: ScrollLineKeyMode;
}

function hasTerminalModifier(key: ScrollKeyLike): boolean {
  return key.ctrl === true || key.meta === true || key.super === true || key.hyper === true;
}

function hasNonCtrlModifier(key: ScrollKeyLike): boolean {
  return key.meta === true || key.super === true || key.hyper === true;
}

function fallbackPageAction(input: string, key: ScrollKeyLike): ScrollKeyAction | null {
  if (key.ctrl !== true || hasNonCtrlModifier(key)) return null;
  if (input === 'b') return 'page-up';
  if (input === 'f') return 'page-down';
  return null;
}

function lineAction(key: ScrollKeyLike, mode: ScrollLineKeyMode): ScrollKeyAction | null {
  if (mode === 'none') return null;
  if (mode === 'shifted') {
    if (!key.shift || hasTerminalModifier(key)) return null;
  } else if (key.shift || hasTerminalModifier(key)) {
    return null;
  }

  if (key.upArrow) return 'line-up';
  if (key.downArrow) return 'line-down';
  return null;
}

export function resolveScrollKey({
  input,
  key,
  lineKeys,
}: ResolveScrollKeyInput): ScrollKeyAction | null {
  if (key.home) return 'top';
  if (key.end) return 'bottom';
  if (key.pageUp) return 'page-up';
  if (key.pageDown) return 'page-down';

  const fallback = fallbackPageAction(input, key);
  if (fallback !== null) return fallback;

  return lineAction(key, lineKeys);
}

interface ScrollStepInput {
  action: ScrollKeyAction;
  position: number;
  page: number;
  last: number;
}

function scrollTarget({ action, position, page, last }: ScrollStepInput): number {
  switch (action) {
    case 'line-up':
      return position - 1;
    case 'line-down':
      return position + 1;
    case 'page-up':
      return position - page;
    case 'page-down':
      return position + page;
    case 'top':
      return 0;
    case 'bottom':
      return last;
    default:
      return assertNever(action);
  }
}

export function stepForScrollAction(input: ScrollStepInput): number {
  return clamp(scrollTarget(input), 0, input.last);
}
