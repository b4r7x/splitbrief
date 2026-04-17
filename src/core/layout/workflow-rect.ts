import type { TuiEvent } from '../types/events.js';
import { getChromeHeight, getContentTopRow } from './chrome-rows.js';

export function hasWorkflowConfig(events: TuiEvent[]): boolean {
  return events.some((event) => event.type === 'workflow-config');
}

export function getWorkflowSidebarWidth(
  cols: number,
  sidebarVisible: boolean,
  isSmall: boolean,
): number {
  return sidebarVisible && !isSmall ? Math.floor(cols * 0.25) : 0;
}

export function getWorkflowContentWidth(
  cols: number,
  sidebarVisible: boolean,
  isSmall: boolean,
): number {
  return cols - getWorkflowSidebarWidth(cols, sidebarVisible, isSmall);
}

export interface WorkflowContentRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
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

export function getWorkflowContentRect(
  cols: number,
  rows: number,
  inputRows: number,
  hasConfig: boolean,
  sidebarVisible: boolean,
  isSmall: boolean,
): WorkflowContentRect {
  const sidebarWidth = getWorkflowSidebarWidth(cols, sidebarVisible, isSmall);
  const width = getWorkflowContentWidth(cols, sidebarVisible, isSmall);
  const height = getWorkflowViewportHeight(rows, inputRows, hasConfig);
  const left = sidebarWidth > 0 ? sidebarWidth + 1 : 1;
  const top = getContentTopRow(hasConfig);
  return {
    left,
    right: left + width - 1,
    top,
    bottom: top + height - 1,
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
