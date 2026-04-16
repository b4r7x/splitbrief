import type { Key } from 'ink';
import type { OverlayType, Screen } from '../core/types/app.js';
import type { TuiEvent } from '../types.js';

export type KeyAction =
  | { type: 'none' }
  | { type: 'exit' }
  | { type: 'cancel-workflow' }
  | { type: 'navigate'; screen: Screen }
  | { type: 'open-overlay'; overlay: OverlayType }
  | { type: 'toggle-sidebar' }
  | { type: 'toggle-diff'; index: number }
  | { type: 'review-scroll'; offset: number }
  | { type: 'conversation-scroll-up'; maxOffset: number; eventCount: number; step: number; totalHeight: number }
  | { type: 'conversation-scroll-down'; step: number }
  | { type: 'conversation-scroll-bottom'; eventCount: number };

const NONE: KeyAction = { type: 'none' };

export function handleShortcutKeys(
  input: string,
  key: Key,
  screen: Screen,
): KeyAction {
  if (key.ctrl && input === 'k') return { type: 'open-overlay', overlay: 'command-palette' };
  if (key.ctrl && input === 's' && screen === 'home') return { type: 'open-overlay', overlay: 'skills' };
  if (key.ctrl && input === 'i' && screen === 'home') return { type: 'open-overlay', overlay: 'settings' };
  if (input === '\x1f') return { type: 'open-overlay', overlay: 'help' }; // Ctrl+/
  if (key.ctrl && input === ',') return { type: 'open-overlay', overlay: 'settings' };
  if (key.ctrl && input === 'q') return { type: 'exit' };
  return NONE;
}

export function handleWorkflowEscape(
  key: Key,
  cancelled: boolean,
): KeyAction {
  if (!key.escape) return NONE;
  if (cancelled) return { type: 'navigate', screen: 'home' };
  return NONE;
}

export function handleWorkflowCtrlChords(
  input: string,
  key: Key,
  isSmall: boolean,
  events: TuiEvent[],
  findLatestDiff: (events: TuiEvent[]) => number | null,
): KeyAction {
  if (!key.ctrl) return NONE;
  if (input === 'e') {
    if (!isSmall) return { type: 'toggle-sidebar' };
    return NONE;
  }
  if (input === 'd') {
    const idx = findLatestDiff(events);
    if (idx != null) return { type: 'toggle-diff', index: idx };
    return NONE;
  }
  return NONE;
}

export function handleReviewScroll(
  input: string,
  key: Key,
  reviewScrollOffset: number,
  reviewLineCount: number,
  visibleHeight: number,
): KeyAction {
  const maxOffset = Math.max(0, reviewLineCount - visibleHeight);
  if (key.upArrow) return { type: 'review-scroll', offset: Math.max(0, reviewScrollOffset - 1) };
  if (key.downArrow) return { type: 'review-scroll', offset: Math.min(maxOffset, reviewScrollOffset + 1) };
  if (input === 'G') return { type: 'review-scroll', offset: maxOffset };
  return NONE;
}

export function handleConversationScroll(
  input: string,
  key: Key,
  eventCount: number,
  maxOffset: number,
  viewportHeight: number,
  totalHeight: number,
): KeyAction {
  const pageStep = Math.max(1, viewportHeight - 2);

  // Shift+Up/Down: scroll 1 line
  if (key.shift && key.upArrow) {
    return { type: 'conversation-scroll-up', maxOffset, eventCount, step: 1, totalHeight };
  }
  if (key.shift && key.downArrow) {
    return { type: 'conversation-scroll-down', step: 1 };
  }

  // PageUp/PageDown: scroll by page
  if (key.pageUp) {
    return { type: 'conversation-scroll-up', maxOffset, eventCount, step: pageStep, totalHeight };
  }
  if (key.pageDown) {
    return { type: 'conversation-scroll-down', step: pageStep };
  }

  // g = top, G = bottom
  if (input === 'g') {
    return { type: 'conversation-scroll-up', maxOffset, eventCount, step: maxOffset, totalHeight };
  }
  if (input === 'G') {
    return { type: 'conversation-scroll-bottom', eventCount };
  }

  return NONE;
}
