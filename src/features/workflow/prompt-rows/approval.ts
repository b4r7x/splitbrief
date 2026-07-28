import { sanitizeTerminalDisplayText } from '../../../utils/display-text.js';
import { SOFT_SEP } from '../../../components/separators.js';
import { CONFIRM_PHRASE } from '../../../core/approval/types.js';
import type { ActionClass } from '../../../core/schemas/enums.js';
import type { ApprovalPromptState } from '../../../stores/approval-prompt/prompt.js';
import { glyph } from '../../../lib/glyphs.js';
import { SPLITBRIEF_DIR } from '../../../core/paths.js';
import { approvalTextWidth, wrappedRows } from './measure.js';

const BORDER_ROWS = 2;

export const APPROVAL_TITLE = 'Approval';
export const CONFIRM_TITLE = 'Confirm';

export const STICKY_HINTS = `a s w x choose${SOFT_SEP}esc cancel`;
export const CONFIRM_HINTS = `⏎ confirm${SOFT_SEP}esc cancel`;

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
  {
    key: 'w',
    label: 'Approve always',
    note: `saved to ${SPLITBRIEF_DIR}/approvals.json`,
  },
  { key: 'x', label: 'Deny' },
];

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
