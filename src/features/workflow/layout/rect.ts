import { clamp } from '../../../utils/math.js';
import { getChromeHeight, getContentTopRow } from './chrome-rows.js';

export const WORKFLOW_CONTENT_PADDING_X = 0;
export const WORKFLOW_SIDEBAR_GAP = 2;

export interface SidebarWidthInput {
  cols: number;
  sidebarVisible: boolean;
  isSmall: boolean;
}

export function getWorkflowSidebarWidth(input: SidebarWidthInput): number {
  const { cols, sidebarVisible, isSmall } = input;
  return sidebarVisible && !isSmall ? Math.max(0, Math.floor(cols * 0.25)) : 0;
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
  isSmall: boolean;
  promptRows?: number;
}

const REVIEW_HEADER_ROWS = 2;
const REVIEW_FOOTER_ROWS = 2;

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
  const { cols, rows, inputRows, sidebarVisible, isSmall, promptRows = 0 } = input;
  const sidebarWidth = getWorkflowSidebarWidth({
    cols,
    sidebarVisible,
    isSmall,
  });
  const width = getWorkflowContentWidth({ cols, sidebarVisible, isSmall });
  const height = getWorkflowViewportHeight({ rows, inputRows, promptRows });
  const left =
    sidebarWidth +
    getWorkflowSidebarGap({ cols, sidebarVisible, isSmall }) +
    WORKFLOW_CONTENT_PADDING_X +
    1;
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
