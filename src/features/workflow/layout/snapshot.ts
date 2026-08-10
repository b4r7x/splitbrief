import { getChromeHeight, getRailActiveIndex, selectRailForm } from './chrome-rows.js';
import {
  briefListTopOffset,
  getRailStageZones,
  resolveRailFraction,
  type RailStageZone,
} from './hit-test.js';
import { clamp } from '../../../utils/math.js';
import {
  getReviewColumnWidth,
  getReviewContentLayout,
  getWorkflowContentRect,
  getWorkflowContentWidth,
  getWorkflowViewportHeight,
  REVIEW_FRAME_ROWS,
} from './rect.js';
import {
  getSimpleBriefMaxTaskOffset,
  getSimpleBriefTaskRowBudget,
  getSimpleBriefVisibleTaskCount,
} from './brief-review.js';
import { inputHeightStore } from '../../../stores/ui/input-height.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { getSections } from '../../../stores/workflow/actions/sections.js';
import { controlsStore } from '../../../stores/ui/controls.js';
import { conversationScrollStore } from '../../../stores/workflow/conversation-scroll.js';
import { streamingOutputStore } from '../../../stores/workflow/streaming-output.js';
import { reviewStore } from '../../../stores/workflow/review.js';
import { lifecycleStore } from '../../../stores/workflow/lifecycle.js';
import { tasksStore } from '../../../stores/workflow/tasks.js';
import { approvalPromptStore } from '../../../stores/approval-prompt/prompt.js';
import { costApprovalStore } from '../../../stores/cost-approval/prompt.js';
import { questionPromptStore } from '../../../stores/question-prompt/prompt.js';
import { getWorkflowPromptRows } from '../prompt-rows/workflow.js';
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
  const controls = controlsStore.get();
  return getWorkflowPromptRows({
    approvalState: approvalPromptStore.get(),
    costApprovalState: costApprovalStore.get(),
    questionHint: controls.inputMode === 'question' ? questionPromptStore.get().hint : null,
    cols: terminalSizeStore.get().cols,
  });
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

function readWorkflowChromeHeight(): number {
  return getChromeHeight(inputHeightStore.get().rows);
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
  return getReviewContentLayout(
    Math.max(0, viewportHeight - REVIEW_FRAME_ROWS),
    reviewStore.get().renderedLineCount,
  ).contentHeight;
}

export interface BriefListSnapshot {
  rect: ReturnType<typeof getWorkflowContentRect>;
  previousCount: number;
  visibleCount: number;
  hasLoadError: boolean;
  taskTopOffset: number;
}

export function readBriefListSnapshot(): BriefListSnapshot | null {
  if (lifecycleStore.get().phase !== 'reviewing-briefs') return null;
  const { rows, cols } = terminalSizeStore.get();
  const promptRows = readWorkflowPromptRows();
  const contentRect = getWorkflowContentRect({
    cols,
    rows,
    inputRows: inputHeightStore.get().rows,
    sidebarVisible: controlsStore.get().sidebarVisible,
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
  return {
    rect,
    previousCount,
    visibleCount,
    hasLoadError,
    taskTopOffset: briefListTopOffset({ hasLoadError }),
  };
}

function readConversationLayoutSnapshot(): ConversationLayoutSnapshot {
  const { rows, cols } = terminalSizeStore.get();
  const promptRows = readWorkflowPromptRows();
  const viewportHeight = getWorkflowViewportHeight({
    rows,
    inputRows: inputHeightStore.get().rows,
    promptRows,
  });
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
  });
  const contentRect = getWorkflowContentRect({
    cols,
    rows,
    inputRows: inputHeightStore.get().rows,
    sidebarVisible,
    promptRows,
  });
  return {
    conversationRect: contentRect,
    conversationWidth: contentWidth,
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
