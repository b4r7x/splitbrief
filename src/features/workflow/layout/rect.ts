import { clamp } from '../../../utils/math.js';
import { getChromeHeight, getContentTopRow } from './chrome-rows.js';

export const WORKFLOW_CONTENT_PADDING_X = 1;

export interface SidebarWidthInput {
  cols: number;
  sidebarVisible: boolean;
  isSmall: boolean;
}

export function getWorkflowSidebarWidth(input: SidebarWidthInput): number {
  const { cols, sidebarVisible, isSmall } = input;
  return sidebarVisible && !isSmall ? Math.max(0, Math.floor(cols * 0.25)) : 0;
}

function getWorkflowContentPaneWidth(input: SidebarWidthInput): number {
  return Math.max(0, input.cols - getWorkflowSidebarWidth(input));
}

export function getWorkflowContentWidth(input: SidebarWidthInput): number {
  return Math.max(0, getWorkflowContentPaneWidth(input) - WORKFLOW_CONTENT_PADDING_X * 2);
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
    leftOffset: sidebarWidth + WORKFLOW_CONTENT_PADDING_X,
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

export interface WorkflowRuntimeLayout {
  conversationWidth: number;
  contentWidth: number;
}

export function getWorkflowRuntimeLayout(input: { contentWidth: number }): WorkflowRuntimeLayout {
  const { contentWidth } = input;
  return {
    conversationWidth: contentWidth,
    contentWidth,
  };
}

export function getWorkflowConversationRect(
  contentRect: WorkflowContentRect,
  runtimeLayout: WorkflowRuntimeLayout,
): WorkflowContentRect {
  const width = runtimeLayout.conversationWidth;
  return {
    ...contentRect,
    width,
    right: width > 0 ? contentRect.left + width - 1 : contentRect.left,
  };
}

export interface WorkflowContentRectInput {
  cols: number;
  rows: number;
  inputRows: number;
  railExtraRows: number;
  sidebarVisible: boolean;
  isSmall: boolean;
  promptRows?: number;
}

const REVIEW_HEADER_ROWS = 2;
const REVIEW_FOOTER_ROWS = 2;

function getWorkflowMiddleRows(rows: number, inputRows: number, railExtraRows: number): number {
  return Math.max(0, rows - getChromeHeight(inputRows, railExtraRows));
}

export function clampWorkflowPromptRows(
  rows: number,
  inputRows: number,
  railExtraRows: number,
  promptRows: number,
): number {
  return clamp(promptRows, 0, getWorkflowMiddleRows(rows, inputRows, railExtraRows));
}

export function getWorkflowViewportHeight(
  rows: number,
  inputRows: number,
  railExtraRows = 0,
  promptRows = 0,
): number {
  return Math.max(
    0,
    getWorkflowMiddleRows(rows, inputRows, railExtraRows) -
      clampWorkflowPromptRows(rows, inputRows, railExtraRows, promptRows),
  );
}

export function getWorkflowContentRect(input: WorkflowContentRectInput): WorkflowContentRect {
  const { cols, rows, inputRows, railExtraRows, sidebarVisible, isSmall, promptRows = 0 } = input;
  const sidebarWidth = getWorkflowSidebarWidth({
    cols,
    sidebarVisible,
    isSmall,
  });
  const width = getWorkflowContentWidth({ cols, sidebarVisible, isSmall });
  const height = getWorkflowViewportHeight(rows, inputRows, railExtraRows, promptRows);
  const left = sidebarWidth + WORKFLOW_CONTENT_PADDING_X + 1;
  const top = getContentTopRow(railExtraRows, height);
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
