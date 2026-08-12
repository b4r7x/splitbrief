import { wrapHard, wrapPathAware } from '../../../utils/wrap.js';

export const MIN_TEXT_WIDTH = 1;

export function wrappedRows(text: string, width: number): number {
  const textWidth = Math.max(MIN_TEXT_WIDTH, width);
  return Math.max(1, wrapHard(text, textWidth).split('\n').length);
}

// Approval subjects are file paths and argv. They are pre-wrapped here rather than left to Ink so
// the break lands after a separator, and so the row budget counts exactly what gets rendered.
export function wrapPathAwareText(text: string, width: number): string {
  return wrapPathAware(text, Math.max(MIN_TEXT_WIDTH, width));
}

export function pathAwareRows(text: string, width: number): number {
  return Math.max(1, wrapPathAwareText(text, width).split('\n').length);
}

export const APPROVAL_HORIZONTAL_CHROME = 4;
export const COST_HORIZONTAL_CHROME = 4;

export function approvalTextWidth(cols: number): number {
  return Math.max(MIN_TEXT_WIDTH, cols - APPROVAL_HORIZONTAL_CHROME);
}

export function costTextWidth(cols: number): number {
  return Math.max(MIN_TEXT_WIDTH, cols - COST_HORIZONTAL_CHROME);
}
