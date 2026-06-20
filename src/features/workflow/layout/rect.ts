import { getChromeHeight, getContentTopRow } from './chrome-rows.js';

export const WORKFLOW_CONTENT_PADDING_X = 1;

export function hasWorkflowConfig(events: readonly { type: string }[]): boolean {
  return events.some((event) => event.type === 'workflow_config');
}

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
const REVIEW_SCROLL_CHROME_ROWS = 2;

function getWorkflowMiddleRows(
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
  return Math.max(
    0,
    getWorkflowMiddleRows(rows, inputRows, hasConfig, cols) -
      clampWorkflowPromptRows(rows, inputRows, hasConfig, promptRows, cols),
  );
}

export function getWorkflowContentRect(input: WorkflowContentRectInput): WorkflowContentRect {
  const { cols, rows, inputRows, hasConfig, sidebarVisible, isSmall, promptRows = 0 } = input;
  const sidebarWidth = getWorkflowSidebarWidth({ cols, sidebarVisible, isSmall });
  const width = getWorkflowContentWidth({ cols, sidebarVisible, isSmall });
  const height = getWorkflowViewportHeight(rows, inputRows, hasConfig, promptRows, cols);
  const left = sidebarWidth + WORKFLOW_CONTENT_PADDING_X + 1;
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
  renderedLineCount: number,
): ReviewContentLayout {
  const availableRows = Math.max(0, containerHeight - REVIEW_HEADER_ROWS);
  const contentWithoutFooter = Math.max(0, availableRows - REVIEW_SCROLL_CHROME_ROWS);
  const showFooter =
    renderedLineCount > contentWithoutFooter &&
    availableRows >= REVIEW_SCROLL_CHROME_ROWS + REVIEW_FOOTER_ROWS;
  return {
    contentHeight: Math.max(
      0,
      availableRows - REVIEW_SCROLL_CHROME_ROWS - (showFooter ? REVIEW_FOOTER_ROWS : 0),
    ),
    showFooter,
  };
}
