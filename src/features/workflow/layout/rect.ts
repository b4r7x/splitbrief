import { clamp } from '../../../utils/math.js';
import { getChromeHeight, getContentTopRow } from './chrome-rows.js';

export const WORKFLOW_CONTENT_PADDING_X = 0;
export const WORKFLOW_SIDEBAR_GAP = 2;

const WORKFLOW_SIDEBAR_MIN_COLS = 120;
const WORKFLOW_SIDEBAR_SHARE = 0.25;
const WORKFLOW_SIDEBAR_MIN_WIDTH = 34;
const WORKFLOW_SIDEBAR_MAX_WIDTH = 48;
// 2 border cells + 2 paddingX cells + the 3-cell bar/marker/space prefix each row paints.
const SIDEBAR_TASK_ROW_OVERHEAD = 7;
const SIDEBAR_TASK_TITLE_MIN = 10;

export interface SidebarWidthInput {
  cols: number;
  sidebarVisible: boolean;
}

export function getWorkflowSidebarWidth(input: SidebarWidthInput): number {
  const { cols, sidebarVisible } = input;
  if (!sidebarVisible || cols < WORKFLOW_SIDEBAR_MIN_COLS) return 0;
  return clamp(
    Math.floor(cols * WORKFLOW_SIDEBAR_SHARE),
    WORKFLOW_SIDEBAR_MIN_WIDTH,
    WORKFLOW_SIDEBAR_MAX_WIDTH,
  );
}

export function getSidebarTaskTitleWidth(input: {
  width: number;
  reservedTailCells: number;
}): number {
  return Math.max(
    SIDEBAR_TASK_TITLE_MIN,
    input.width - SIDEBAR_TASK_ROW_OVERHEAD - input.reservedTailCells,
  );
}

// The gap exists only while the sidebar actually renders, so a hidden sidebar keeps the full width.
function getWorkflowSidebarGap(input: SidebarWidthInput): number {
  return getWorkflowSidebarWidth(input) > 0 ? WORKFLOW_SIDEBAR_GAP : 0;
}

export function getWorkflowContentWidth(input: SidebarWidthInput): number {
  return Math.max(
    0,
    input.cols -
      getWorkflowSidebarWidth(input) -
      getWorkflowSidebarGap(input) -
      WORKFLOW_CONTENT_PADDING_X * 2,
  );
}

export function getReviewColumnWidth(contentWidth: number): number {
  return Math.max(0, contentWidth);
}

export interface WorkflowReviewColumn {
  leftOffset: number;
  width: number;
}

export function getWorkflowReviewColumn(input: SidebarWidthInput): WorkflowReviewColumn {
  const sidebarWidth = getWorkflowSidebarWidth(input);
  return {
    leftOffset: sidebarWidth + getWorkflowSidebarGap(input) + WORKFLOW_CONTENT_PADDING_X,
    width: getReviewColumnWidth(getWorkflowContentWidth(input)),
  };
}

export interface WorkflowContentRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
}

export interface WorkflowContentRectInput {
  cols: number;
  rows: number;
  inputRows: number;
  sidebarVisible: boolean;
  promptRows?: number;
}

const REVIEW_HEADER_ROWS = 2;
const REVIEW_FOOTER_ROWS = 2;
// FramePanel's top and bottom border rows around the review document. Every
// consumer measuring the visible review height must subtract these, or keyboard
// and wheel maxOffset drift from the rendered bottom by exactly this amount.
export const REVIEW_FRAME_ROWS = 2;

function getWorkflowMiddleRows(rows: number, inputRows: number): number {
  return Math.max(0, rows - getChromeHeight(inputRows));
}

export function clampWorkflowPromptRows(input: {
  rows: number;
  inputRows: number;
  promptRows: number;
}): number {
  const { rows, inputRows, promptRows } = input;
  return clamp(promptRows, 0, getWorkflowMiddleRows(rows, inputRows));
}

export function getWorkflowViewportHeight(input: {
  rows: number;
  inputRows: number;
  promptRows?: number;
}): number {
  const { rows, inputRows, promptRows = 0 } = input;
  return Math.max(
    0,
    getWorkflowMiddleRows(rows, inputRows) -
      clampWorkflowPromptRows({ rows, inputRows, promptRows }),
  );
}

export function getWorkflowContentRect(input: WorkflowContentRectInput): WorkflowContentRect {
  const { cols, rows, inputRows, sidebarVisible, promptRows = 0 } = input;
  const sidebarWidth = getWorkflowSidebarWidth({ cols, sidebarVisible });
  const width = getWorkflowContentWidth({ cols, sidebarVisible });
  const height = getWorkflowViewportHeight({ rows, inputRows, promptRows });
  const left =
    sidebarWidth + getWorkflowSidebarGap({ cols, sidebarVisible }) + WORKFLOW_CONTENT_PADDING_X + 1;
  const top = getContentTopRow();
  const right = width > 0 ? left + width - 1 : left;
  const bottom = height > 0 ? top + height - 1 : top;
  return {
    left,
    right,
    top,
    bottom,
    width,
    height,
  };
}

export interface ReviewContentLayout {
  contentHeight: number;
  showFooter: boolean;
}

export function getReviewContentLayout(
  containerHeight: number,
  renderedLineCount: number,
): ReviewContentLayout {
  const availableRows = Math.max(0, containerHeight - REVIEW_HEADER_ROWS);
  const showFooter = renderedLineCount > availableRows && availableRows >= REVIEW_FOOTER_ROWS;
  return {
    contentHeight: Math.max(0, availableRows - (showFooter ? REVIEW_FOOTER_ROWS : 0)),
    showFooter,
  };
}
