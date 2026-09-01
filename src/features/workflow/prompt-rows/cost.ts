import { formatCostGateSummary } from '../../../core/cost-gate-summary.js';
import type { CostGateSummary } from '../../../core/cost-gate-summary.js';
import { SOFT_SEP } from '../../../components/separators.js';
import type { CostApprovalState } from '../../../stores/cost-approval/prompt.js';
import type { CostPrediction } from '../../../core/schemas/summary.js';
import {
  CONFIRM_HINT,
  DENY_HINT,
  approvalKeyColumnWidth,
  approvalOptionLabelLines,
  formatKeyHints,
  type ApprovalOption,
} from './approval.js';
import { costTextWidth, wrappedRows } from './measure.js';

// The option rows spell `y` and `x`; `enter` also approves and appears nowhere else, so by the
// same rule every gate panel follows, the legend carries it and the escape and nothing more.
export const COST_HINTS = formatKeyHints([{ key: CONFIRM_HINT.key, verb: 'approve' }, DENY_HINT]);

// `Deny` answers `x` on every gate. `n` is still accepted for a cost gate but is no longer taught.
export const COST_OPTIONS: ReadonlyArray<ApprovalOption> = [
  { key: 'y', label: 'Approve' },
  { key: 'x', label: 'Deny' },
];

export const COST_KIND = 'cost';

// The gate title is one row plus the blank under it, exactly like the sticky and confirm panels.
const COST_TITLE_ROWS = 1;
const COST_PAD_TOP_ROWS = 1;
const COST_GAP_ROWS = 1;
const COST_OPTION_GAP_ROWS = 1;
const COST_BORDER_TOP_ROWS = 1;
const COST_BORDER_BOTTOM_ROWS = 1;

export interface CostGateComparisonRow {
  label: string;
  value: string;
  emphasis: boolean;
}

export function costGateHeaderLine(summary: CostGateSummary): string {
  return `${summary.taskCount} tasks`;
}

export function costGateComparisonRows(summary: CostGateSummary): CostGateComparisonRow[] {
  return [
    { label: summary.estimateLabel, value: summary.estimatedCost, emphasis: false },
    { label: summary.allPlannerLabel, value: summary.allPlannerCost, emphasis: false },
    {
      label: summary.savingsLabel,
      value: `${summary.estimatedSavings}${SOFT_SEP}${summary.savingsPercentage}%`,
      emphasis: true,
    },
  ];
}

export function costGateComparisonLineText(row: CostGateComparisonRow): string {
  return `${row.label}  ${row.value}`;
}

function costHeaderRows(summary: CostGateSummary, width: number): number {
  return wrappedRows(costGateHeaderLine(summary), width);
}

function costComparisonRowCount(summary: CostGateSummary, width: number): number {
  return costGateComparisonRows(summary).reduce(
    (sum, row) => sum + wrappedRows(costGateComparisonLineText(row), width),
    0,
  );
}

function costScopeRows(summary: CostGateSummary, width: number): number {
  return summary.scopeNote ? wrappedRows(summary.scopeNote, width) : 0;
}

function costOptionRows(width: number): number {
  const keyWidth = approvalKeyColumnWidth(COST_OPTIONS);
  return COST_OPTIONS.reduce(
    (rows, option) => rows + approvalOptionLabelLines({ option, keyWidth, width }).length,
    0,
  );
}

export function getCostApprovalButtonRowOffset(prediction: CostPrediction, cols: number): number {
  const summary = formatCostGateSummary(prediction);
  if (!summary) {
    return COST_BORDER_TOP_ROWS + COST_TITLE_ROWS + COST_PAD_TOP_ROWS + COST_GAP_ROWS;
  }
  const width = costTextWidth(cols);
  return (
    COST_BORDER_TOP_ROWS +
    COST_TITLE_ROWS +
    COST_PAD_TOP_ROWS +
    costHeaderRows(summary, width) +
    costComparisonRowCount(summary, width) +
    costScopeRows(summary, width) +
    COST_GAP_ROWS
  );
}

export function getCostApprovalPromptRowsForPrediction(
  prediction: CostPrediction,
  cols: number,
): number {
  const width = costTextWidth(cols);
  return (
    getCostApprovalButtonRowOffset(prediction, cols) +
    costOptionRows(width) +
    COST_OPTION_GAP_ROWS +
    wrappedRows(COST_HINTS, width) +
    COST_BORDER_BOTTOM_ROWS
  );
}

export function getCostApprovalPromptRows(state: CostApprovalState, cols: number): number {
  if (state.status !== 'pending') return 0;
  return getCostApprovalPromptRowsForPrediction(state.prediction, cols);
}
