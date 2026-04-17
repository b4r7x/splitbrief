import { getChromeHeight } from '../../core/layout/chrome-rows.js';
import {
  getReviewContentHeight,
  getWorkflowContentRect,
  getWorkflowContentWidth,
  getWorkflowViewportHeight,
  hasWorkflowConfig,
} from '../../core/layout/workflow-rect.js';
import { computeConversationScroll } from '../../core/layout/conversation-scroll.js';
import { inputHeightStore } from '../../stores/ui/input-height.js';
import { terminalSizeStore } from '../../stores/ui/terminal-size.js';
import { eventsStore } from '../../stores/workflow/events.js';
import { getSections } from '../../stores/workflow/actions.js';
import { controlsStore } from '../../stores/ui/controls.js';
import { conversationScrollStore } from '../../stores/workflow/conversation-scroll.js';
import { reviewStore } from '../../stores/workflow/review.js';

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
    hasWorkflowConfig(eventsStore.get().events),
  );
}

export function readReviewContentHeight(): number {
  const viewportHeight = Math.max(0, terminalSizeStore.get().rows - readWorkflowChromeHeight());
  return getReviewContentHeight(viewportHeight, reviewStore.get().lineCount);
}

export function readConversationScrollSnapshot(): ConversationScrollSnapshot {
  const { rows, cols, isSmall } = terminalSizeStore.get();
  const events = eventsStore.get().events;
  const scroll = conversationScrollStore.get();
  const hasConfig = hasWorkflowConfig(events);
  const viewportHeight = getWorkflowViewportHeight(
    rows,
    inputHeightStore.get().rows,
    hasConfig,
  );
  const sidebarVisible = controlsStore.get().sidebarVisible;
  const contentWidth = getWorkflowContentWidth(cols, sidebarVisible, isSmall);
  const contentRect = getWorkflowContentRect(
    cols,
    rows,
    inputHeightStore.get().rows,
    hasConfig,
    sidebarVisible,
    isSmall,
  );
  const {
    maxOffset,
    renderableCount,
    scrollOffset,
    totalDynamicHeight,
  } = computeConversationScroll({
    sections: getSections(),
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
