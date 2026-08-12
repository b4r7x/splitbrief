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
// `escalated` is the longest status word, plus the two cells of gap before it.
const SIDEBAR_TASK_TAIL_CELLS = 11;

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

export function getWorkflowConversationHeight(input: {
  height: number;
  sidebarWidth: number;
}): number {
  return Math.max(0, input.height - (input.sidebarWidth > 0 ? 1 : 0));
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

// Every row in a list that holds a tail-bearing task reserves the status column, filled or not, so
// all titles truncate in the same place instead of ragging against a right-aligned word. A list
// with nothing escalated, failed, or skipped reserves nothing and spends the cells on titles.
export interface SidebarStatusColumnOptions {
  hasStatusTail: boolean;
}

export function getSidebarStatusColumnCells({ hasStatusTail }: SidebarStatusColumnOptions): number {
  return hasStatusTail ? SIDEBAR_TASK_TAIL_CELLS : 0;
}

// 2 border rows + the count header + the blank row under it + the footer divider.
const SIDEBAR_LIST_CHROME_ROWS = 5;

export function getSidebarTaskListRows(input: { height: number; footerRows: number }): number {
  return Math.max(0, input.height - SIDEBAR_LIST_CHROME_ROWS - Math.max(0, input.footerRows));
}

export interface SidebarTaskWindow {
  start: number;
  end: number;
  hiddenAbove: number;
  hiddenBelow: number;
  showAbove: boolean;
  showBelow: boolean;
  combine: boolean;
}

// Windows the task list around the anchor (the running task) so it stays on screen no matter how
// long the plan is. Overflow markers claim a row each; the two passes settle which of them the
// window needs, because pass one cannot know whether the offsets it produces overflow both edges.
// A task row always outranks a marker row, so a budget too small for both collapses them into one
// `combine` row that still names both edges, and a budget too small even for that reports every
// marker as not shown rather than pushing the list past its rows.
export function getSidebarTaskWindow(input: {
  itemCount: number;
  anchorIndex: number;
  rows: number;
}): SidebarTaskWindow {
  const rows = Math.max(0, Math.floor(input.rows));
  const itemCount = Math.max(0, Math.floor(input.itemCount));
  if (rows === 0 || itemCount === 0) {
    return {
      start: 0,
      end: 0,
      hiddenAbove: 0,
      hiddenBelow: itemCount,
      showAbove: false,
      showBelow: false,
      combine: false,
    };
  }
  if (itemCount <= rows) {
    return {
      start: 0,
      end: itemCount,
      hiddenAbove: 0,
      hiddenBelow: 0,
      showAbove: false,
      showBelow: false,
      combine: false,
    };
  }

  const anchor = clamp(Math.floor(input.anchorIndex), 0, itemCount - 1);
  const markerBudget = rows - 1;
  let capacity = rows;
  let start = 0;
  for (let pass = 0; pass < 2; pass += 1) {
    const wanted = (start > 0 ? 1 : 0) + (start + capacity < itemCount ? 1 : 0);
    capacity = rows - Math.min(wanted, markerBudget);
    start = clamp(anchor - Math.floor((capacity - 1) / 2), 0, itemCount - capacity);
  }

  const end = start + capacity;
  const hiddenAbove = start;
  const hiddenBelow = itemCount - end;
  const spare = rows - capacity;
  const wantAbove = hiddenAbove > 0;
  const wantBelow = hiddenBelow > 0;
  // One spare row cannot host both edges separately. Showing only one of them would hide that the
  // list continues in the other direction, so the single row carries both counts instead.
  const combine = wantAbove && wantBelow && spare === 1;
  const showAbove = wantAbove && spare > 0 && !combine;
  const showBelow = wantBelow && spare > (showAbove ? 1 : 0) && !combine;
  return { start, end, hiddenAbove, hiddenBelow, showAbove, showBelow, combine };
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
