import { panelModel } from '../../../components/preparation-problem.js';
import { getRailActiveIndex } from '../../../core/phases/rail.js';
import { seatLineText } from '../../../core/crew/seat-line/collapse.js';
import { getTerminalCellWidth } from '../../../utils/display-text/width.js';
import { overlayStore } from '../../../stores/ui/overlay.js';
import { readStopMenuRows } from '../stop/options.js';
import { inlineMenuLayout } from '../inline-menu/layout.js';
import { getProgressRows, selectRailFormAndLine } from './chrome-rows.js';
import { wrappedHeaderCrew } from '../display/header-seat-lines.js';
import { readHeaderSeatLines } from '../hooks/use-header-seat-lines.js';
import { readRailCells, readRailStages } from '../hooks/use-rail-cells.js';
import { getRailStageZones, resolveRailFraction, type RailStageZone } from './hit-test.js';
import {
  getReviewContentLayout,
  getReviewPanelBudget,
  getWorkflowContentRect,
  getWorkflowSidebarWidth,
  getWorkflowViewportHeight,
  REVIEW_FRAME_ROWS,
} from './rect.js';
import { inputHeightStore } from '../../../stores/ui/input-height.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { routerStore } from '../../../stores/navigation/router.js';
import { getSections } from '../../../stores/workflow/actions/sections.js';
import { controlsStore } from '../../../stores/ui/controls.js';
import { conversationScrollStore } from '../../../stores/workflow/conversation-scroll.js';
import { streamingOutputStore } from '../../../stores/workflow/streaming-output.js';
import { reviewStore } from '../../../stores/workflow/review.js';
import { lifecycleStore } from '../../../stores/workflow/lifecycle/state.js';
import { runViewStore } from '../../../stores/workflow/run-view.js';
import { stopStore } from '../../../stores/workflow/stop.js';
import { approvalPromptStore } from '../../../stores/prompts/approval.js';
import { questionPromptStore } from '../../../stores/prompts/question.js';
import { recoveryNoticeStore } from '../../../stores/workflow/recovery-notice.js';
import { reviewArtifactForPhase } from '../prompt-rows/review-document.js';
import { getWorkflowPromptRows } from '../prompt-rows/workflow.js';
import { computeConversationRowScroll } from '../conversation-rows/scroll.js';
import { readTranscriptTail } from '../conversation-rows/transcript-tail.js';
import { splitConversationViewport } from '../conversation-rows/viewport.js';
import { queuedBriefs } from '../conversation-rows/queued-briefs.js';
import { resultMenuStore } from '../../../stores/workflow/result-menu.js';
import { routeClosedAtRest } from '../at-rest.js';
import { feedbackStore } from '../../../stores/ui/feedback.js';
import { sessionSelectStore } from '../../../stores/navigation/session-select.js';
import { getFeedbackRows, workflowNoticeBudget } from '../components/feedback-row.js';

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

function readWrappedCrewHeight(): number {
  const cols = terminalSizeStore.get().cols;
  const singleStageCells = readRailCells({
    form: 'C',
    short: true,
    buildBlockShown: false,
    stages: readRailStages(),
  });
  return wrappedHeaderCrew(
    cols,
    singleStageCells,
    readHeaderSeatLines(),
    routeClosedAtRest(routerStore.get()),
  ).length;
}

function readStopMenuHeight(cols: number): number {
  return overlayStore.get().active === 'stop-sheet'
    ? inlineMenuLayout(readStopMenuRows(), cols).height
    : 0;
}

function readWorkflowPromptRows(): number {
  const stopMenuRows = readStopMenuHeight(terminalSizeStore.get().cols);
  if (stopMenuRows > 0) return stopMenuRows;
  const resultMenuRows = resultMenuStore.get();
  if (resultMenuRows !== null) return resultMenuRows;
  const controls = controlsStore.get();
  const approvalState = approvalPromptStore.get();
  const recoveryIssue = runViewStore.get().halt?.issue ?? null;
  const questionHint = controls.inputMode === 'question' ? questionPromptStore.get().hint : null;
  const recoveryPrompt =
    recoveryIssue !== null && recoveryNoticeStore.get().asking && questionHint !== null;
  const artifact = readReviewArtifact();

  return getWorkflowPromptRows({
    approvalState,
    questionHint,
    review:
      artifact === null
        ? undefined
        : {
            artifact,
            confirms: reviewStore.get().confirms,
            budgetRows: getReviewPanelBudget({
              rows: terminalSizeStore.get().rows - readWrappedCrewHeight(),
              inputRows: inputHeightStore.get().rows,
              feedbackRows: readFeedbackRows(),
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
    phase: runViewStore.get().phase,
    cols: terminalSizeStore.get().cols,
    cancelled: lifecycle.cancelled,
    halted: runViewStore.get().halt !== null,
    promptRows,
    atRest: route.screen === 'workflow' && route.execution.kind === 'at-rest',
    parked: stopStore.get().phase === 'parked',
  });
}

function readReviewArtifact() {
  return controlsStore.get().inputMode === 'review' &&
    approvalPromptStore.get().status !== 'pending' &&
    overlayStore.get().active === 'none'
    ? reviewArtifactForPhase(runViewStore.get().phase)
    : null;
}

// The footer's message rows, asked from the store the row paints from.
function readFeedbackRows(): number {
  const { cols, rows } = terminalSizeStore.get();
  const bodyRows = rows - readWrappedCrewHeight();
  const inputRows = inputHeightStore.get().rows;
  return getFeedbackRows({
    feedback: feedbackStore.get(),
    terminalCols: cols,
    problem: panelModel(sessionSelectStore.get().preparation),
    maxRows: workflowNoticeBudget(
      cols,
      bodyRows,
      inputRows,
      readReviewArtifact(),
      reviewStore.get().confirms,
    ),
    bodyRows,
    inputRows,
    stopMenuRows: readStopMenuHeight(cols),
  });
}

function readRailFraction(): string {
  const view = runViewStore.get();
  const lifecycle = lifecycleStore.get();
  return resolveRailFraction({
    phase: view.phase,
    tasks: view.briefs,
    cancelled: lifecycle.cancelled,
    buildBlockShown: readProgressRows(readWorkflowPromptRows()) > 0,
  });
}

export interface RailSnapshot {
  zones: RailStageZone[];
  activeIndex: number;
}

export function readRailSnapshot(): RailSnapshot {
  const { cols } = terminalSizeStore.get();
  const phase = runViewStore.get().phase;
  const cancelled = lifecycleStore.get().cancelled;
  const fraction = readRailFraction();
  const buildBlockShown = readProgressRows(readWorkflowPromptRows()) > 0;
  const stages = readRailStages();
  const lines = readHeaderSeatLines();
  const choice = selectRailFormAndLine({
    cols,
    railWidths: {
      B: readRailCells({ form: 'B', short: false, buildBlockShown, stages }),
      BShort: readRailCells({ form: 'B', short: true, buildBlockShown, stages }),
      C: readRailCells({ form: 'C', buildBlockShown, stages }),
      CShort: readRailCells({ form: 'C', short: true, buildBlockShown, stages }),
    },
    modelLineCells: getTerminalCellWidth(seatLineText(lines.model)),
    toolLineCells: getTerminalCellWidth(seatLineText(lines.tool)),
  });
  return {
    zones: getRailStageZones({
      form: choice.form,
      short: choice.short,
      phase,
      cols,
      fraction,
      cancelled,
      stages,
    }),
    activeIndex: getRailActiveIndex(phase),
  };
}

export function readReviewContentHeight(): number {
  const promptRows = readWorkflowPromptRows();
  const viewportHeight = getWorkflowViewportHeight({
    rows: terminalSizeStore.get().rows,
    inputRows: inputHeightStore.get().rows,
    feedbackRows: readFeedbackRows(),
    promptRows,
    progressRows: readProgressRows(promptRows) + readWrappedCrewHeight(),
  });
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
    feedbackRows: readFeedbackRows(),
    sidebarVisible,
    promptRows,
    progressRows: readProgressRows(promptRows) + readWrappedCrewHeight(),
  });
  const sidebarShowsTasks = getWorkflowSidebarWidth({ cols, sidebarVisible }) > 0;
  const pendingTasks = queuedBriefs({
    tasks: runViewStore.get().briefs,
    phase: runViewStore.get().phase,
    sidebarShowsTasks,
    closed: routeClosedAtRest(routerStore.get()),
  });
  const viewportSplit = splitConversationViewport({
    viewportHeight: contentRect.height,
    sections: getSections(),
    pendingTaskCount: pendingTasks.length,
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
    closed: routeClosedAtRest(routerStore.get()),
    streaming: streamingOutputStore.get(),
    tail: readTranscriptTail(),
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
