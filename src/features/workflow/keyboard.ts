import type { Key } from 'ink';
import type { Section } from '../../core/layout/event-sections.js';

export type WorkflowKeyAction =
  | { type: 'none' }
  | { type: 'navigate-home' }
  | { type: 'toggle-sidebar' }
  | { type: 'toggle-diff'; index: number }
  | { type: 'review-scroll'; offset: number }
  | { type: 'conversation-scroll-up'; renderableCount: number; step: number; totalHeight: number }
  | { type: 'conversation-scroll-down'; step: number }
  | { type: 'conversation-scroll-bottom'; renderableCount: number };

const NONE: WorkflowKeyAction = { type: 'none' };

export function handleWorkflowEscape(
  key: Key,
  cancelled: boolean,
): WorkflowKeyAction {
  if (!key.escape) return NONE;
  if (cancelled) return { type: 'navigate-home' };
  return NONE;
}

export function handleWorkflowCtrlChords(
  input: string,
  key: Key,
  isSmall: boolean,
  sections: Section[],
  findLatestDiff: (sections: Section[]) => number | null,
): WorkflowKeyAction {
  if (!key.ctrl) return NONE;
  if (input === 'e') {
    if (!isSmall) return { type: 'toggle-sidebar' };
    return NONE;
  }
  if (input === 'd') {
    const idx = findLatestDiff(sections);
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
): WorkflowKeyAction {
  const maxOffset = Math.max(0, reviewLineCount - visibleHeight);
  if (key.upArrow) return { type: 'review-scroll', offset: Math.max(0, reviewScrollOffset - 1) };
  if (key.downArrow) return { type: 'review-scroll', offset: Math.min(maxOffset, reviewScrollOffset + 1) };
  if (input === 'G') return { type: 'review-scroll', offset: maxOffset };
  return NONE;
}

export function handleConversationScroll(
  input: string,
  key: Key,
  renderableCount: number,
  maxOffset: number,
  viewportHeight: number,
  totalHeight: number,
): WorkflowKeyAction {
  const pageStep = Math.max(1, viewportHeight - 2);

  if (key.shift && key.upArrow) {
    return { type: 'conversation-scroll-up', renderableCount, step: 1, totalHeight };
  }
  if (key.shift && key.downArrow) {
    return { type: 'conversation-scroll-down', step: 1 };
  }

  if (key.pageUp) {
    return { type: 'conversation-scroll-up', renderableCount, step: pageStep, totalHeight };
  }
  if (key.pageDown) {
    return { type: 'conversation-scroll-down', step: pageStep };
  }

  if (input === 'g') {
    return { type: 'conversation-scroll-up', renderableCount, step: maxOffset, totalHeight };
  }
  if (input === 'G') {
    return { type: 'conversation-scroll-bottom', renderableCount };
  }

  return NONE;
}
