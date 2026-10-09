import { getRailActiveIndex } from '../../../core/rail-stages.js';
import { overlayStore } from '../../../stores/ui/overlay.js';
import { readStopMenuRows, stopMenuLayout } from '../stop/options.js';
import { reviewChecksCardLayout } from '../review-checks/options.js';
import { getProgressRows, selectRailForm } from './chrome-rows.js';
import { getRailStageZones, resolveRailFraction, type RailStageZone } from './hit-test.js';
import {
  getReviewContentLayout,
  getReviewPanelBudget,
  getWorkflowContentRect,
  getWorkflowSidebarWidth,
  getWorkflowViewportHeight,
  REVIEW_FRAME_ROWS,
} from './rect.js';
import { getSimpleBriefTaskRowBudget, getSimpleBriefVisibleTaskCount } from './brief-review.js';
import { inputHeightStore } from '../../../stores/ui/input-height.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { routerStore } from '../../../stores/navigation/router.js';
import { getSections } from '../../../stores/workflow/actions/sections.js';
import { controlsStore } from '../../../stores/ui/controls.js';
import { conversationScrollStore } from '../../../stores/workflow/conversation-scroll.js';
import { streamingOutputStore } from '../../../stores/workflow/streaming-output.js';
import { transcriptTailStore } from '../../../stores/workflow/transcript-tail.js';
import { reviewStore } from '../../../stores/workflow/review.js';
import { lifecycleStore } from '../../../stores/workflow/lifecycle.js';
import { tasksStore } from '../../../stores/workflow/tasks.js';
import { stopStore } from '../../../stores/workflow/stop.js';
import { approvalPromptStore } from '../../../stores/approval-prompt/prompt.js';
import { reviewChecksPromptStore } from '../../../stores/review-checks-prompt/prompt.js';
import { questionPromptStore } from '../../../stores/question-prompt/prompt.js';
import { recoveryNoticeStore } from '../../../stores/workflow/recovery-notice.js';
import { formatRecoveryPrompt } from '../recovery-prompt.js';
import { reviewArtifactForPhase } from '../prompt-rows/approval.js';
import { getWorkflowPromptRows } from '../prompt-rows/workflow.js';
import type { ConversationRowBlock } from '../conversation-rows/types.js';
import { computeConversationRowScroll } from '../conversation-rows/scroll.js';
import { splitConversationViewport } from '../conversation-rows/viewport.js';

export interface ConversationScrollSnapshot {
  conversationWidth: number;
  contentRect: ReturnType<typeof getWorkflowContentRect>;
  maxOffset: number;
  renderableCount: number;
  scrollOffset: number;
  totalHeight: number;
  viewportHeight: number;
  transcriptViewportHeight: number;
}

export interface ConversationHoverSnapshot {
  contentRect: ReturnType<typeof getWorkflowContentRect>;
  viewportHeight: number;
}

interface ConversationLayoutSnapshot {
  conversationWidth: number;
  contentRect: ReturnType<typeof getWorkflowContentRect>;
  viewportSplit: ReturnType<typeof splitConversationViewport>;
  transcriptViewportHeight: number;
}

function readWorkflowPromptRows(): number {
  if (overlayStore.get().active === 'stop-sheet')
    return stopMenuLayout(readStopMenuRows(), terminalSizeStore.get().cols).height;
  const checks = reviewChecksPromptStore.get();
  if (checks.status === 'pending') {
    return reviewChecksCardLayout(checks.request, terminalSizeStore.get().cols).height;
  }
  const controls = controlsStore.get();
  const approvalState = approvalPromptStore.get();
  const recoveryIssue = recoveryNoticeStore.get().issue;
  const questionHint = controls.inputMode === 'question' ? questionPromptStore.get().hint : null;
  const recoveryPrompt =
    recoveryIssue !== null &&
    questionHint !== null &&
    questionHint === formatRecoveryPrompt(recoveryIssue);
  // A tiered gate takes the zone from the review panel, so the two are never budgeted together.
  const documentReview = controls.inputMode === 'review' && approvalState.status !== 'pending';
  return getWorkflowPromptRows({
    approvalState,
    questionHint,
    review: {
      artifact: documentReview ? reviewArtifactForPhase(lifecycleStore.get().phase) : null,
      confirms: reviewStore.get().confirms,
      budgetRows: getReviewPanelBudget({
        rows: terminalSizeStore.get().rows,
        inputRows: inputHeightStore.get().rows,
      }),
    },
    recoveryIssue: recoveryPrompt ? recoveryIssue : null,
    questions: questionPromptStore.get().questions,
    questionIndex: questionPromptStore.get().index,
    questionWriting: questionPromptStore.get().focus === 'answer',
    cols: terminalSizeStore.get().cols,
  });
}

// The build block's rows, asked from the same facts the screen asks from
// (`src/app/screens/workflow.tsx`). The input paths measure the same body or they scroll and
// hit-test a viewport the renderer never painted.
function readProgressRows(promptRows: number): number {
  const lifecycle = lifecycleStore.get();
  const route = routerStore.get();
  return getProgressRows({
    phase: lifecycle.phase,
    cols: terminalSizeStore.get().cols,
    cancelled: lifecycle.cancelled,
    halted: recoveryNoticeStore.get().issue !== null,
    promptRows,
    atRest: route.screen === 'workflow' && route.execution.kind === 'at-rest',
    parked: stopStore.get().phase === 'parked',
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
  const promptRows = readWorkflowPromptRows();
  const viewportHeight = getWorkflowViewportHeight({
    rows: terminalSizeStore.get().rows,
    inputRows: inputHeightStore.get().rows,
    promptRows,
    progressRows: readProgressRows(promptRows),
  });
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

function readConversationLayoutSnapshot(): ConversationLayoutSnapshot {
  const { rows, cols } = terminalSizeStore.get();
  const promptRows = readWorkflowPromptRows();
  const sidebarVisible = controlsStore.get().sidebarVisible;
  const contentRect = getWorkflowContentRect({
    cols,
    rows,
    inputRows: inputHeightStore.get().rows,
    sidebarVisible,
    promptRows,
    progressRows: readProgressRows(promptRows),
  });
  // The queued block stands down while the sidebar lists the same pending work, so the keyboard
  // path has to read the same suppression the transcript renders under or it budgets rows for a
  // block that paints nothing.
  const sidebarShowsTasks = getWorkflowSidebarWidth({ cols, sidebarVisible }) > 0;
  const viewportSplit = splitConversationViewport({
    viewportHeight: contentRect.height,
    sections: getSections(),
    pendingTaskCount: sidebarShowsTasks
      ? 0
      : tasksStore.get().tasks.filter((task) => task.status === 'pending').length,
  });
  return {
    conversationWidth: contentRect.width,
    contentRect,
    viewportSplit,
    transcriptViewportHeight: viewportSplit.transcriptViewportHeight,
  };
}

export function readConversationHoverSnapshot(): ConversationHoverSnapshot {
  const layout = readConversationLayoutSnapshot();
  return {
    contentRect: layout.contentRect,
    viewportHeight: layout.transcriptViewportHeight,
  };
}

/**
 * What the screen appended after the run's own events, as measurements only: the keys scroll the
 * same document the renderer painted, and they never need the rows themselves.
 */
function transcriptTailBlocks(): readonly ConversationRowBlock[] {
  const { rowCount, renderableUnits } = transcriptTailStore.get();
  if (rowCount === 0 && renderableUnits === 0) return [];
  return [{ key: 'transcript-tail', rowCount, renderableUnits, createRows: () => [] }];
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
    tail: transcriptTailBlocks(),
  });
  return {
    conversationWidth: layout.conversationWidth,
    contentRect: layout.contentRect,
    maxOffset,
    renderableCount,
    scrollOffset,
    totalHeight: totalDynamicHeight,
    viewportHeight: scrollViewportHeight,
    transcriptViewportHeight: layout.transcriptViewportHeight,
  };
}
