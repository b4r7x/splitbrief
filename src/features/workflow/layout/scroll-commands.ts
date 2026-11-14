import type {
  ScrollCommandTarget,
  ScrollConversationResult,
  ToggleLatestActivityBatchResult,
} from '../../../core/runtime/commands/types.js';
import { conversationScrollStore } from '../../../stores/workflow/conversation-scroll.js';
import { assertNever } from '../../../utils/type-guards.js';
import {
  findLatestConversationRowAction,
  type ConversationRowAction,
} from '../conversation-rows/row-actions/build.js';
import { toggleFoldedRows } from '../conversation-rows/toggle-folded-rows.js';

export interface ConversationScrollMetrics {
  renderableCount: number;
  totalHeight: number;
  maxOffset: number;
  viewportHeight: number;
}

function conversationPageStep(viewportHeight: number): number {
  return Math.max(1, viewportHeight - 1);
}

export function scrollConversation(
  target: ScrollCommandTarget,
  readScrollMetrics: () => ConversationScrollMetrics,
): ScrollConversationResult {
  const metrics = readScrollMetrics();
  switch (target) {
    case 'top':
      conversationScrollStore.scrollUp({
        renderableCount: metrics.renderableCount,
        totalHeight: metrics.totalHeight,
        step: metrics.maxOffset,
        maxOffset: metrics.maxOffset,
      });
      return { status: 'scrolled' };
    case 'bottom':
      conversationScrollStore.scrollToBottom(metrics.renderableCount);
      return { status: 'scrolled' };
    case 'page-up':
      conversationScrollStore.scrollUp({
        renderableCount: metrics.renderableCount,
        totalHeight: metrics.totalHeight,
        step: conversationPageStep(metrics.viewportHeight),
        maxOffset: metrics.maxOffset,
      });
      return { status: 'scrolled' };
    case 'page-down':
      conversationScrollStore.scrollDown(conversationPageStep(metrics.viewportHeight));
      return { status: 'scrolled' };
    default:
      return assertNever(target);
  }
}

export function toggleLatestActivityBatch(
  getRowActions: () => ReadonlyMap<string, ConversationRowAction>,
): ToggleLatestActivityBatchResult {
  const action = findLatestConversationRowAction(getRowActions(), 'toggle-activity-batch');
  if (action === null) {
    return {
      status: 'unavailable',
      message: 'No folded rows to expand.',
    };
  }

  const expanded = !conversationScrollStore.get().expandedActivityBatches.has(action.key);
  toggleFoldedRows(action.key);
  return { status: 'toggled', expanded };
}
