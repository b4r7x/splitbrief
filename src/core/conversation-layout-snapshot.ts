import { getChromeHeight } from '../core/chrome-rows.js';
import {
  getReviewContentHeight,
  getWorkflowContentRect,
  getWorkflowContentWidth,
  getWorkflowViewportHeight,
  hasWorkflowConfig,
} from '../core/workflow-rect.js';
import { computeConversationScroll } from '../core/conversation-scroll.js';
import { inputHeightStore } from '../stores/input-height.js';
import { terminalSizeStore } from '../stores/terminal-size.js';
import { workflowStore } from '../stores/workflow.js';
import { conversationScrollStore } from '../stores/conversation-scroll.js';
import { reviewStore } from '../stores/review.js';

export interface ConversationScrollSnapshot {
  contentRect: ReturnType<typeof getWorkflowContentRect>;
  maxOffset: number;
  renderableCount: number;
  scrollOffset: number;
  totalHeight: number;
  viewportHeight: number;
}

function readWorkflowChromeHeight(): number {
  return getChromeHeight(
    inputHeightStore.get().rows,
    hasWorkflowConfig(workflowStore.get().events),
  );
}

export function readReviewContentHeight(): number {
  const viewportHeight = Math.max(0, terminalSizeStore.get().rows - readWorkflowChromeHeight());
  return getReviewContentHeight(viewportHeight, reviewStore.get().lineCount);
}

export function readConversationScrollSnapshot(): ConversationScrollSnapshot {
  const { rows, cols, isSmall } = terminalSizeStore.get();
  const workflow = workflowStore.get();
  const scroll = conversationScrollStore.get();
  const hasConfig = hasWorkflowConfig(workflow.events);
  const viewportHeight = getWorkflowViewportHeight(
    rows,
    inputHeightStore.get().rows,
    hasConfig,
  );
  const contentWidth = getWorkflowContentWidth(cols, workflow.sidebarVisible, isSmall);
  const contentRect = getWorkflowContentRect(
    cols,
    rows,
    inputHeightStore.get().rows,
    hasConfig,
    workflow.sidebarVisible,
    isSmall,
  );
  const {
    maxOffset,
    renderableCount,
    scrollOffset,
    totalDynamicHeight,
  } = computeConversationScroll({
    sections: workflow.sections,
    expandedDiffs: scroll.expandedDiffs,
    cols: contentWidth,
    viewportHeight,
    rawScrollOffset: scroll.scrollOffset,
    renderableCountAtScroll: scroll.renderableCountAtScroll,
    heightAtScroll: scroll.heightAtScroll,
  });
  return {
    contentRect,
    maxOffset,
    renderableCount,
    scrollOffset,
    totalHeight: totalDynamicHeight,
    viewportHeight,
  };
}
