import {
  getChromeHeight,
  getRailActiveIndex,
  getRailExtraRows,
  selectRailForm,
} from './chrome-rows.js';
import { getRailStageZones, resolveRailFraction, type RailStageZone } from './hit-test.js';
import { clamp } from '../../../utils/math.js';
import {
  getReviewColumnWidth,
  getWorkflowConversationRect,
  getReviewContentLayout,
  getWorkflowContentRect,
  getWorkflowContentWidth,
  getWorkflowRuntimeLayout,
  getWorkflowViewportHeight,
} from './rect.js';
import {
  getSimpleBriefMaxTaskOffset,
  getSimpleBriefTaskRowBudget,
  getSimpleBriefVisibleTaskCount,
} from './brief-review.js';
import { inputHeightStore } from '../../../stores/ui/input-height.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { getSections } from '../../../stores/workflow/actions.js';
import { controlsStore } from '../../../stores/ui/controls.js';
import { conversationScrollStore } from '../../../stores/workflow/conversation-scroll.js';
import { streamingOutputStore } from '../../../stores/workflow/streaming-output.js';
import { reviewStore } from '../../../stores/workflow/review.js';
import { lifecycleStore } from '../../../stores/workflow/lifecycle.js';
import { tasksStore } from '../../../stores/workflow/tasks.js';
import { approvalPromptStore } from '../../../stores/approval-prompt/prompt.js';
import { costApprovalStore } from '../../../stores/cost-approval/prompt.js';
import { getWorkflowPromptRows } from '../prompt-rows.js';
import { computeConversationRowScroll } from '../conversation-rows/scroll.js';
import { splitConversationViewport } from '../conversation-rows/viewport.js';

export interface ConversationScrollSnapshot {
  conversationRect: ReturnType<typeof getWorkflowContentRect>;
  conversationWidth: number;
  contentRect: ReturnType<typeof getWorkflowContentRect>;
  maxOffset: number;
  renderableCount: number;
  scrollOffset: number;
  totalHeight: number;
  viewportHeight: number;
  transcriptViewportHeight: number;
  stickyLeadingRows: number;
}

export interface ConversationHoverSnapshot {
  conversationRect: ReturnType<typeof getWorkflowContentRect>;
  stickyLeadingRows: number;
  viewportHeight: number;
}

interface ConversationLayoutSnapshot {
  conversationRect: ReturnType<typeof getWorkflowContentRect>;
  conversationWidth: number;
  contentRect: ReturnType<typeof getWorkflowContentRect>;
  viewportSplit: ReturnType<typeof splitConversationViewport>;
  transcriptViewportHeight: number;
}

function readWorkflowPromptRows(): number {
  return getWorkflowPromptRows(
    approvalPromptStore.get(),
    costApprovalStore.get(),
    terminalSizeStore.get().cols,
  );
}

function readRailFraction(): string {
  const tasks = tasksStore.get();
  const lifecycle = lifecycleStore.get();
  return resolveRailFraction({
    phase: lifecycle.phase,
    currentTask: tasks.currentTask,
    totalTasks: tasks.totalTasks,
    cancelled: lifecycle.cancelled,
  });
}

function readRailExtraRows(): number {
  const { phase, cancelled } = lifecycleStore.get();
  const form = selectRailForm({ phase, cols: terminalSizeStore.get().cols });
  return getRailExtraRows(form, phase, cancelled);
}

function readWorkflowChromeHeight(): number {
  return getChromeHeight(inputHeightStore.get().rows, readRailExtraRows());
}

function hasReviewLoadError(): boolean {
  return reviewStore.get().loadError !== null;
}

export interface RailSnapshot {
  zones: RailStageZone[];
  activeIndex: number;
}

export function readRailSnapshot(): RailSnapshot {
  const { cols } = terminalSizeStore.get();
  const phase = lifecycleStore.get().phase;
  const cancelled = lifecycleStore.get().cancelled;
  const fraction = readRailFraction();
  const form = selectRailForm({ phase, cols });
  return {
    zones: getRailStageZones({ form, phase, cols, fraction, cancelled }),
    activeIndex: getRailActiveIndex(phase),
  };
}

export function readReviewContentHeight(): number {
  const viewportHeight = Math.max(
    0,
    terminalSizeStore.get().rows - readWorkflowChromeHeight() - readWorkflowPromptRows(),
  );
  if (lifecycleStore.get().phase === 'reviewing-briefs') {
    const rowBudget = getSimpleBriefTaskRowBudget({
      containerHeight: viewportHeight,
      hasLoadError: hasReviewLoadError(),
    });
    return getSimpleBriefVisibleTaskCount({
      rowBudget,
      taskCount: reviewStore.get().renderedLineCount,
    });
  }
  return getReviewContentLayout(viewportHeight, reviewStore.get().renderedLineCount).contentHeight;
}

export interface BriefListSnapshot {
  rect: ReturnType<typeof getWorkflowContentRect>;
  previousCount: number;
  visibleCount: number;
  hasLoadError: boolean;
}

export function readBriefListSnapshot(): BriefListSnapshot | null {
  if (lifecycleStore.get().phase !== 'reviewing-briefs') return null;
  const { rows, cols, isSmall } = terminalSizeStore.get();
  const railExtraRows = readRailExtraRows();
  const promptRows = readWorkflowPromptRows();
  const contentRect = getWorkflowContentRect({
    cols,
    rows,
    inputRows: inputHeightStore.get().rows,
    railExtraRows,
    sidebarVisible: controlsStore.get().sidebarVisible,
    isSmall,
    promptRows,
  });
  // The brief column spans the full content pane (no width cap). Routing the width through
  // getReviewColumnWidth keeps a single source of truth for the rendered column geometry so the
  // hit-test rect can never drift from what the renderer paints.
  const reviewWidth = getReviewColumnWidth(contentRect.width);
  const rect = {
    ...contentRect,
    width: reviewWidth,
    right: reviewWidth > 0 ? contentRect.left + reviewWidth - 1 : contentRect.left,
  };
  const hasLoadError = hasReviewLoadError();
  const rowBudget = getSimpleBriefTaskRowBudget({
    containerHeight: contentRect.height,
    hasLoadError,
  });
  const taskCount = reviewStore.get().renderedLineCount;
  const maxStart = getSimpleBriefMaxTaskOffset({ rowBudget, taskCount });
  const previousCount = clamp(Math.floor(reviewStore.get().scrollOffset), 0, maxStart);
  // Clamp to the tasks actually rendered in the window so a tall terminal with few briefs never
  // leaves a phantom hotspot below the last row that maps to an out-of-bounds task index.
  const visibleCount = Math.min(
    getSimpleBriefVisibleTaskCount({ rowBudget, taskCount }),
    taskCount - previousCount,
  );
  return { rect, previousCount, visibleCount, hasLoadError };
}

function readConversationLayoutSnapshot(): ConversationLayoutSnapshot {
  const { rows, cols, isSmall } = terminalSizeStore.get();
  const railExtraRows = readRailExtraRows();
  const promptRows = readWorkflowPromptRows();
  const viewportHeight = getWorkflowViewportHeight(
    rows,
    inputHeightStore.get().rows,
    railExtraRows,
    promptRows,
  );
  const sections = getSections();
  const viewportSplit = splitConversationViewport({
    viewportHeight,
    sections,
    pendingTaskCount: tasksStore.get().tasks.filter((task) => task.status === 'pending').length,
  });
  const sidebarVisible = controlsStore.get().sidebarVisible;
  const contentWidth = getWorkflowContentWidth({
    cols,
    sidebarVisible,
    isSmall,
  });
  const runtimeLayout = getWorkflowRuntimeLayout({
    contentWidth,
  });
  const contentRect = getWorkflowContentRect({
    cols,
    rows,
    inputRows: inputHeightStore.get().rows,
    railExtraRows,
    sidebarVisible,
    isSmall,
    promptRows,
  });
  const conversationRect = getWorkflowConversationRect(contentRect, runtimeLayout);
  return {
    conversationRect,
    conversationWidth: runtimeLayout.conversationWidth,
    contentRect,
    viewportSplit,
    transcriptViewportHeight: viewportSplit.transcriptViewportHeight,
  };
}

export function readConversationHoverSnapshot(): ConversationHoverSnapshot {
  const layout = readConversationLayoutSnapshot();
  return {
    conversationRect: layout.conversationRect,
    stickyLeadingRows: layout.viewportSplit.stickyLeadingRows,
    viewportHeight: layout.transcriptViewportHeight,
  };
}

export function readConversationScrollSnapshot(): ConversationScrollSnapshot {
  const layout = readConversationLayoutSnapshot();
  const scroll = conversationScrollStore.get();
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
    cols: layout.conversationWidth,
    viewportHeight: layout.transcriptViewportHeight,
    rawScrollOffset: scroll.scrollOffset,
    renderableCountAtScroll: scroll.renderableCountAtScroll,
    heightAtScroll: scroll.heightAtScroll,
    streaming: streamingOutputStore.get(),
  });
  return {
    conversationRect: layout.conversationRect,
    conversationWidth: layout.conversationWidth,
    contentRect: layout.contentRect,
    maxOffset,
    renderableCount,
    scrollOffset,
    totalHeight: totalDynamicHeight,
    viewportHeight: scrollViewportHeight,
    transcriptViewportHeight: layout.transcriptViewportHeight,
    stickyLeadingRows: layout.viewportSplit.stickyLeadingRows,
  };
}
