import { getChromeHeight, getContentTopRow } from './chrome-rows.js';

export function hasWorkflowConfig(events: readonly { type: string }[]): boolean {
  return events.some((event) => event.type === 'workflow_config');
}

export function getWorkflowSidebarWidth(
  cols: number,
  sidebarVisible: boolean,
  isSmall: boolean,
): number {
  return sidebarVisible && !isSmall ? Math.max(0, Math.floor(cols * 0.25)) : 0;
}

export function getWorkflowContentWidth(
  cols: number,
  sidebarVisible: boolean,
  isSmall: boolean,
): number {
  return Math.max(0, cols - getWorkflowSidebarWidth(cols, sidebarVisible, isSmall));
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
  hasConfig: boolean;
  sidebarVisible: boolean;
  isSmall: boolean;
  promptRows?: number;
}

const REVIEW_HEADER_ROWS = 2;
const REVIEW_FOOTER_ROWS = 1;

export function getWorkflowMiddleRows(
  rows: number,
  inputRows: number,
  hasConfig: boolean,
  cols?: number,
): number {
  return Math.max(0, rows - getChromeHeight(inputRows, hasConfig, cols));
}

export function clampWorkflowPromptRows(
  rows: number,
  inputRows: number,
  hasConfig: boolean,
  promptRows: number,
  cols?: number,
): number {
  return Math.min(Math.max(0, promptRows), getWorkflowMiddleRows(rows, inputRows, hasConfig, cols));
}

export function getWorkflowViewportHeight(
  rows: number,
  inputRows: number,
  hasConfig: boolean,
  promptRows = 0,
  cols?: number,
): number {
  return Math.max(0, getWorkflowMiddleRows(rows, inputRows, hasConfig, cols) - clampWorkflowPromptRows(rows, inputRows, hasConfig, promptRows, cols));
}

export function getWorkflowContentRect(input: WorkflowContentRectInput): WorkflowContentRect {
  const { cols, rows, inputRows, hasConfig, sidebarVisible, isSmall, promptRows = 0 } = input;
  const sidebarWidth = getWorkflowSidebarWidth(cols, sidebarVisible, isSmall);
  const width = getWorkflowContentWidth(cols, sidebarVisible, isSmall);
  const height = getWorkflowViewportHeight(rows, inputRows, hasConfig, promptRows, cols);
  const left = sidebarWidth > 0 ? sidebarWidth + 1 : 1;
  const top = getContentTopRow(hasConfig, cols);
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
  lineCount: number,
): ReviewContentLayout {
  const baseContentHeight = Math.max(0, containerHeight - REVIEW_HEADER_ROWS);
  const showFooter = lineCount > baseContentHeight && baseContentHeight >= REVIEW_FOOTER_ROWS;
  return {
    contentHeight: Math.max(0, baseContentHeight - (showFooter ? REVIEW_FOOTER_ROWS : 0)),
    showFooter,
  };
}

export function getReviewContentHeight(containerHeight: number, lineCount: number): number {
  return getReviewContentLayout(containerHeight, lineCount).contentHeight;
}
