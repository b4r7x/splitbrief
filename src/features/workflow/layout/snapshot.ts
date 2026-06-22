import { getChromeHeight } from './chrome-rows.js';
import {
  getWorkflowConversationRect,
  getReviewContentLayout,
  getWorkflowContentRect,
  getWorkflowContentWidth,
  getWorkflowRuntimeLayout,
  getWorkflowViewportHeight,
  hasWorkflowConfig,
} from './rect.js';
import { getSimpleBriefTaskRowBudget, getSimpleBriefVisibleTaskCount } from './brief-review.js';
import { inputHeightStore } from '../../../stores/ui/input-height.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { eventsStore } from '../../../stores/workflow/events.js';
import { getSections } from '../../../stores/workflow/actions.js';
import { controlsStore } from '../../../stores/ui/controls.js';
import { conversationScrollStore } from '../../../stores/workflow/conversation-scroll.js';
import { streamingOutputStore } from '../../../stores/workflow/streaming-output.js';
import { reviewStore } from '../../../stores/workflow/review.js';
import { lifecycleStore } from '../../../stores/workflow/lifecycle.js';
import { approvalPromptStore } from '../../../stores/approval-prompt/prompt.js';
import { costApprovalStore } from '../../../stores/cost-approval/prompt.js';
import { getWorkflowPromptRows } from '../prompt-rows.js';
import { computeConversationRowScroll } from '../conversation-rows/scroll.js';

export interface ConversationScrollSnapshot {
  activityRailWidth: number;
  conversationRect: ReturnType<typeof getWorkflowContentRect>;
  conversationWidth: number;
  contentRect: ReturnType<typeof getWorkflowContentRect>;
  maxOffset: number;
  renderableCount: number;
  scrollOffset: number;
  totalHeight: number;
  viewportHeight: number;
}

function readWorkflowChromeHeight(): number {
  const { cols } = terminalSizeStore.get();
  return getChromeHeight(
    inputHeightStore.get().rows,
    hasWorkflowConfig(eventsStore.get().events),
    cols,
  );
}

function readWorkflowPromptRows(): number {
  return getWorkflowPromptRows(
    approvalPromptStore.get(),
    costApprovalStore.get(),
    terminalSizeStore.get().cols,
  );
}

export function readReviewContentHeight(): number {
  const viewportHeight = Math.max(
    0,
    terminalSizeStore.get().rows - readWorkflowChromeHeight() - readWorkflowPromptRows(),
  );
  if (lifecycleStore.get().phase === 'reviewing-briefs') {
    const rowBudget = getSimpleBriefTaskRowBudget({
      containerHeight: viewportHeight,
      hasLoadError: false,
    });
    return getSimpleBriefVisibleTaskCount({
      rowBudget,
      taskCount: reviewStore.get().renderedLineCount,
    });
  }
  return getReviewContentLayout(viewportHeight, reviewStore.get().renderedLineCount).contentHeight;
}

export function readConversationScrollSnapshot(): ConversationScrollSnapshot {
  const { rows, cols, isSmall } = terminalSizeStore.get();
  const events = eventsStore.get().events;
  const scroll = conversationScrollStore.get();
  const hasConfig = hasWorkflowConfig(events);
  const promptRows = readWorkflowPromptRows();
  const viewportHeight = getWorkflowViewportHeight(
    rows,
    inputHeightStore.get().rows,
    hasConfig,
    promptRows,
    cols,
  );
  const sidebarVisible = controlsStore.get().sidebarVisible;
  const contentWidth = getWorkflowContentWidth({
    cols,
    sidebarVisible,
    isSmall,
  });
  const runtimeLayout = getWorkflowRuntimeLayout({
    contentWidth,
    terminalCols: cols,
  });
  const contentRect = getWorkflowContentRect({
    cols,
    rows,
    inputRows: inputHeightStore.get().rows,
    hasConfig,
    sidebarVisible,
    isSmall,
    promptRows,
  });
  const conversationRect = getWorkflowConversationRect(contentRect, runtimeLayout);
  const {
    maxOffset,
    renderableCount,
    scrollOffset,
    totalDynamicHeight,
    viewportHeight: scrollViewportHeight,
  } = computeConversationRowScroll({
    sections: getSections(),
    expandedDiffs: scroll.expandedDiffs,
    expandedActivityBatches: scroll.expandedActivityBatches,
    cols: runtimeLayout.conversationWidth,
    viewportHeight,
    rawScrollOffset: scroll.scrollOffset,
    renderableCountAtScroll: scroll.renderableCountAtScroll,
    heightAtScroll: scroll.heightAtScroll,
    streaming: streamingOutputStore.get(),
  });
  return {
    activityRailWidth: runtimeLayout.activityRailWidth,
    conversationRect,
    conversationWidth: runtimeLayout.conversationWidth,
    contentRect,
    maxOffset,
    renderableCount,
    scrollOffset,
    totalHeight: totalDynamicHeight,
    viewportHeight: scrollViewportHeight,
  };
}
