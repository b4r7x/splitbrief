import type { Phase } from '../../../core/schemas/enums.js';
import { getChromeHeight, getProgressRows } from './chrome-rows.js';
import {
  clampWorkflowPromptRows,
  getWorkflowContentWidth,
  getWorkflowSidebarWidth,
  getWorkflowViewportHeight,
} from './rect.js';

export function workflowScreenLayout(input: {
  cols: number;
  rows: number;
  inputRows: number;
  sidebarVisible: boolean;
  /** The rows the panel above the composer asks for: a menu, a gate, the plan card, a question. */
  requestedPromptRows: number;
  phase: Phase;
  cancelled: boolean;
  halted: boolean;
  atRest: boolean;
  parked: boolean;
}) {
  const { cols, rows, inputRows, sidebarVisible, requestedPromptRows } = input;
  const progressRows = getProgressRows({
    phase: input.phase,
    cols,
    cancelled: input.cancelled,
    halted: input.halted,
    promptRows: requestedPromptRows,
    atRest: input.atRest,
    parked: input.parked,
  });
  const promptRows = clampWorkflowPromptRows({
    rows,
    inputRows,
    progressRows,
    promptRows: requestedPromptRows,
  });
  // An open panel keeps a row while the chrome fits; the header gives its row up first.
  const promptBoxRows =
    rows < getChromeHeight(inputRows, progressRows)
      ? 0
      : Math.max(Math.min(1, requestedPromptRows), promptRows);
  return {
    sidebarWidth: getWorkflowSidebarWidth({ cols, sidebarVisible }),
    progressRows,
    promptBoxRows,
    contentHeight: getWorkflowViewportHeight({
      rows,
      inputRows,
      progressRows,
      promptRows: promptBoxRows,
    }),
    contentWidth: getWorkflowContentWidth({ cols, sidebarVisible }),
  };
}
