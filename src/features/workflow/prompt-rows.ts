import { wrapHard } from '../../utils/wrap.js';
import { sanitizeTerminalDisplayText } from '../../utils/display-text.js';
import { formatCostGateSummary } from '../../core/cost-gate-summary.js';
import { CONFIRM_PHRASE } from '../../core/approval/types.js';
import type { ActionClass } from '../../core/schemas/enums.js';
import type { CostPrediction } from '../../core/schemas/summary.js';
import type { ApprovalPromptState } from '../../stores/approval-prompt/prompt.js';
import type { CostApprovalState } from '../../stores/cost-approval/prompt.js';

const MIN_TEXT_WIDTH = 1;
const BORDER_ROWS = 2;
const APPROVAL_HORIZONTAL_CHROME = 4;
const COST_HORIZONTAL_CHROME = 6;

function wrappedRows(text: string, width: number): number {
  const textWidth = Math.max(MIN_TEXT_WIDTH, width);
  return Math.max(1, wrapHard(text, textWidth).split('\n').length);
}

function approvalTextWidth(cols: number): number {
  return Math.max(MIN_TEXT_WIDTH, cols - APPROVAL_HORIZONTAL_CHROME);
}

function costTextWidth(cols: number): number {
  return Math.max(MIN_TEXT_WIDTH, cols - COST_HORIZONTAL_CHROME);
}

export function getApprovalConfirmLabel(actionClass: ActionClass): string {
  if (actionClass === 'destructive') return 'Control-plane file write';
  if (actionClass === 'package_change') return 'Package manifest write';
  return 'Confirm file write';
}

export function formatApprovalActionDescription(actionDescription: string): string {
  return sanitizeTerminalDisplayText(actionDescription);
}

function getStickyRows(actionDescription: string, cols: number): number {
  const width = approvalTextWidth(cols);
  const safeActionDescription = formatApprovalActionDescription(actionDescription);
  return (
    BORDER_ROWS +
    wrappedRows(`[?] Write outside task scope: ${safeActionDescription}`, width) +
    wrappedRows('  [A] Approve once', width) +
    wrappedRows('  [S] Approve for this session', width) +
    wrappedRows('  [W] Always approve (saved to .diptych/approvals.json)', width) +
    wrappedRows('  [X] Deny', width)
  );
}

function getConfirmRows(actionClass: ActionClass, actionDescription: string, cols: number): number {
  const width = approvalTextWidth(cols);
  const safeActionDescription = formatApprovalActionDescription(actionDescription);
  const actionRows = wrappedRows(
    `[!] ${getApprovalConfirmLabel(actionClass)}: ${safeActionDescription}`,
    width,
  );
  const phraseStepRows =
    wrappedRows(`    Type "${CONFIRM_PHRASE}" to proceed, or press Escape to cancel.`, width) +
    1 +
    1;
  const reasonStepRows =
    wrappedRows('    Phrase accepted. Enter reason:', width) +
    1 +
    wrappedRows('    (Press Enter to confirm, Escape to cancel)', width);

  return BORDER_ROWS + actionRows + Math.max(phraseStepRows, reasonStepRows);
}

export function getApprovalPromptRows(state: ApprovalPromptState, cols: number): number {
  if (state.status !== 'pending') return 0;
  return state.request.tier === 'sticky'
    ? getStickyRows(state.request.actionDescription, cols)
    : getConfirmRows(state.request.actionClass, state.request.actionDescription, cols);
}

export function getCostApprovalPromptRows(state: CostApprovalState, cols: number): number {
  if (state.status !== 'pending') return 0;
  return getCostApprovalPromptRowsForPrediction(state.prediction, cols);
}

export function getCostApprovalPromptRowsForPrediction(
  prediction: CostPrediction,
  cols: number,
): number {
  const summary = formatCostGateSummary(prediction);
  if (!summary) return 0;
  const width = costTextWidth(cols);
  const summaryLine = `${summary.taskCount} tasks | ${summary.estimateLabel}: ${summary.estimatedCost} | ${summary.allPlannerLabel}: ${summary.allPlannerCost} | ${summary.savingsLabel}: ${summary.estimatedSavings} (${summary.savingsPercentage}%)`;
  return (
    8 +
    wrappedRows(summaryLine, width) +
    (summary.scopeNote ? wrappedRows(summary.scopeNote, width) : 0)
  );
}

export function getWorkflowPromptRows(
  approvalState: ApprovalPromptState,
  costApprovalState: CostApprovalState,
  cols: number,
): number {
  return (
    getApprovalPromptRows(approvalState, cols) + getCostApprovalPromptRows(costApprovalState, cols)
  );
}
