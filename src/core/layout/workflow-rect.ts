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
}

const REVIEW_HEADER_ROWS = 1;
const REVIEW_FOOTER_ROWS = 1;

export function getWorkflowViewportHeight(
  rows: number,
  inputRows: number,
  hasConfig: boolean,
): number {
  return Math.max(0, rows - getChromeHeight(inputRows, hasConfig));
}

export function getWorkflowContentRect(input: WorkflowContentRectInput): WorkflowContentRect {
  const { cols, rows, inputRows, hasConfig, sidebarVisible, isSmall } = input;
  const sidebarWidth = getWorkflowSidebarWidth(cols, sidebarVisible, isSmall);
  const width = getWorkflowContentWidth(cols, sidebarVisible, isSmall);
  const height = getWorkflowViewportHeight(rows, inputRows, hasConfig);
  const left = sidebarWidth > 0 ? sidebarWidth + 1 : 1;
  const top = getContentTopRow(hasConfig);
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

export function getReviewContentHeight(containerHeight: number, lineCount: number): number {
  const baseContentHeight = Math.max(0, containerHeight - REVIEW_HEADER_ROWS);
  if (lineCount > baseContentHeight) {
    return Math.max(0, containerHeight - REVIEW_HEADER_ROWS - REVIEW_FOOTER_ROWS);
  }
  return baseContentHeight;
}
