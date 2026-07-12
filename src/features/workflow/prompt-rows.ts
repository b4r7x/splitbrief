import { wrapHard } from '../../utils/wrap.js';
import { sanitizeTerminalDisplayText } from '../../utils/display-text.js';
import { formatCostGateSummary } from '../../core/cost-gate-summary.js';
import type { CostGateSummary } from '../../core/cost-gate-summary.js';
import { SOFT_SEP } from '../../components/separators.js';
import { CONFIRM_PHRASE } from '../../core/approval/types.js';
import type { ActionClass } from '../../core/schemas/enums.js';
import type { CostPrediction } from '../../core/schemas/summary.js';
import type { ApprovalPromptState } from '../../stores/approval-prompt/prompt.js';
import type { CostApprovalState } from '../../stores/cost-approval/prompt.js';
import { glyph } from '../../lib/glyphs.js';
import { countPromptBodyRows } from './prompt-body-rows.js';

const MIN_TEXT_WIDTH = 1;
const BORDER_ROWS = 2;
const APPROVAL_HORIZONTAL_CHROME = 4;
const COST_HORIZONTAL_CHROME = 4;

export const APPROVAL_TITLE = 'Approval';
export const CONFIRM_TITLE = 'Confirm';

export const STICKY_HINTS = `a s w x choose${SOFT_SEP}esc cancel`;
export const CONFIRM_HINTS = `⏎ confirm${SOFT_SEP}esc cancel`;
export const COST_HINTS = `⏎/y approve${SOFT_SEP}esc reject`;

export const CONFIRM_INSTRUCTION_PREFIX = 'type  ';
export const CONFIRM_INSTRUCTION_SUFFIX = '  to proceed';
const CONFIRM_INSTRUCTION = `${CONFIRM_INSTRUCTION_PREFIX}${CONFIRM_PHRASE}${CONFIRM_INSTRUCTION_SUFFIX}`;
export const CONFIRM_QUESTION = 'Why are you making this change?';
export const PHRASE_ACCEPTED = 'phrase accepted';

export interface StickyOption {
  key: string;
  label: string;
  note?: string;
}

export const STICKY_OPTIONS: ReadonlyArray<StickyOption> = [
  { key: 'a', label: 'Approve once' },
  { key: 's', label: 'Approve this session' },
  { key: 'w', label: 'Approve always', note: 'saved to .diptych/approvals.json' },
  { key: 'x', label: 'Deny' },
];

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
  if (actionClass === 'destructive') return 'control-plane file write';
  if (actionClass === 'package_change') return 'package manifest write';
  return 'confirm file write';
}

export function getApprovalSeverityWord(actionClass: ActionClass): string {
  if (actionClass === 'destructive') return 'destructive';
  if (actionClass === 'package_change') return 'package';
  if (actionClass === 'network') return 'network';
  if (actionClass === 'write_out_of_scope') return 'scope';
  return 'Confirm';
}

export function formatApprovalActionDescription(actionDescription: string): string {
  return sanitizeTerminalDisplayText(actionDescription);
}

function stickyRequestLine(actionClass: ActionClass, actionDescription: string): string {
  return `${getApprovalSeverityWord(actionClass)}   ${formatApprovalActionDescription(actionDescription)}`;
}

function stickyOptionBody(option: StickyOption): string {
  const base = `${option.key}   ${option.label}`;
  return option.note ? `${base}${SOFT_SEP}${option.note}` : base;
}

export const STICKY_OPTION_FIRST_ROW_OFFSET = 4;

export interface PromptOptionZone {
  key: string;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export function stickyRequestRowCount(
  actionClass: ActionClass,
  actionDescription: string,
  cols: number,
): number {
  return wrappedRows(stickyRequestLine(actionClass, actionDescription), approvalTextWidth(cols));
}

export function getStickyOptionZones(input: {
  boxTop: number;
  cols: number;
  promptRows: number;
  actionClass: ActionClass;
  actionDescription: string;
}): PromptOptionZone[] {
  const width = approvalTextWidth(input.cols);
  const requestRows = stickyRequestRowCount(input.actionClass, input.actionDescription, input.cols);
  const left = 1;
  const right = Math.max(1, input.cols);
  const boxBottom = input.boxTop + input.promptRows - 1;
  const zones: PromptOptionZone[] = [];
  let offset = STICKY_OPTION_FIRST_ROW_OFFSET + requestRows;
  for (const option of STICKY_OPTIONS) {
    const optionRows = wrappedRows(`  ${stickyOptionBody(option)}`, width);
    const top = input.boxTop + offset;
    const bottom = top + optionRows - 1;
    offset += optionRows;
    if (bottom > boxBottom) break;
    zones.push({ key: option.key, left, right, top, bottom });
  }
  return zones;
}

function confirmSeverityLine(actionClass: ActionClass): string {
  return `${getApprovalSeverityWord(actionClass)}   ${getApprovalConfirmLabel(actionClass)}`;
}

function confirmCommandLine(actionDescription: string): string {
  return `${formatApprovalActionDescription(actionDescription)}${SOFT_SEP}this cannot be undone`;
}

const COST_PAD_TOP_ROWS = 1;
const COST_GAP_ROWS = 1;
const COST_BUTTON_ROWS = 1;
const COST_BUTTON_GAP_ROWS = 1;
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
  return summary.scopeNote ? wrappedRows(summary.scopeNote, width) + 1 : 0;
}

function getStickyRows(actionClass: ActionClass, actionDescription: string, cols: number): number {
  const width = approvalTextWidth(cols);
  return (
    BORDER_ROWS +
    1 +
    1 +
    stickyRequestRowCount(actionClass, actionDescription, cols) +
    1 +
    STICKY_OPTIONS.reduce(
      (rows, option) => rows + wrappedRows(`  ${stickyOptionBody(option)}`, width),
      0,
    ) +
    1 +
    wrappedRows(STICKY_HINTS, width)
  );
}

function getConfirmRows(actionClass: ActionClass, actionDescription: string, cols: number): number {
  const width = approvalTextWidth(cols);
  const phraseStepRows =
    1 +
    1 +
    wrappedRows(confirmSeverityLine(actionClass), width) +
    wrappedRows(confirmCommandLine(actionDescription), width) +
    1 +
    wrappedRows(CONFIRM_INSTRUCTION, width) +
    1 +
    1 +
    wrappedRows(CONFIRM_HINTS, width);
  const reasonStepRows =
    1 +
    1 +
    wrappedRows(`${glyph('check')} ${PHRASE_ACCEPTED}`, width) +
    wrappedRows(CONFIRM_QUESTION, width) +
    1 +
    1 +
    wrappedRows(CONFIRM_HINTS, width);
  return BORDER_ROWS + Math.max(phraseStepRows, reasonStepRows);
}

export function getApprovalPromptRows(state: ApprovalPromptState, cols: number): number {
  if (state.status !== 'pending') return 0;
  return state.request.tier === 'sticky'
    ? getStickyRows(state.request.actionClass, state.request.actionDescription, cols)
    : getConfirmRows(state.request.actionClass, state.request.actionDescription, cols);
}

export function getCostApprovalPromptRows(state: CostApprovalState, cols: number): number {
  if (state.status !== 'pending') return 0;
  return getCostApprovalPromptRowsForPrediction(state.prediction, cols);
}

// Row offset (from the box's top border) of the approve/reject button row. Both the rendered prompt
// and the clickable button zones derive their geometry from this single function so a mouse click
// can never land on the wrong row. When the summary is null (unpriced / non-deterministic) the gate
// collapses to a numberless approve/reject prompt with no header/comparison/scope rows.
export function getCostApprovalButtonRowOffset(prediction: CostPrediction, cols: number): number {
  const summary = formatCostGateSummary(prediction);
  if (!summary) return COST_BORDER_TOP_ROWS + COST_PAD_TOP_ROWS + COST_GAP_ROWS;
  const width = costTextWidth(cols);
  return (
    COST_BORDER_TOP_ROWS +
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
    COST_BUTTON_ROWS +
    COST_BUTTON_GAP_ROWS +
    wrappedRows(COST_HINTS, width) +
    COST_BORDER_BOTTOM_ROWS
  );
}

export const QUESTION_PROMPT_HORIZONTAL_CHROME = 4;
const QUESTION_PROMPT_BORDER_ROWS = 2;

export function getQuestionPromptRows(hint: string, cols: number): number {
  const width = Math.max(MIN_TEXT_WIDTH, cols - QUESTION_PROMPT_HORIZONTAL_CHROME);
  return QUESTION_PROMPT_BORDER_ROWS + Math.max(1, countPromptBodyRows(hint, width));
}

export interface WorkflowPromptRowsInput {
  approvalState: ApprovalPromptState;
  costApprovalState: CostApprovalState;
  questionHint: string | null;
  cols: number;
}

export function getWorkflowPromptRows(input: WorkflowPromptRowsInput): number {
  const { approvalState, costApprovalState, questionHint, cols } = input;
  return (
    getApprovalPromptRows(approvalState, cols) +
    getCostApprovalPromptRows(costApprovalState, cols) +
    (questionHint === null ? 0 : getQuestionPromptRows(questionHint, cols))
  );
}
