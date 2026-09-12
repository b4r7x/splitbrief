import { sanitizeTerminalDisplayText } from '../../../utils/display-text.js';
import { SOFT_SEP } from '../../../components/separators.js';
import type { ActionClass } from '../../../core/schemas/enums.js';
import type { ApprovalPromptState } from '../../../stores/approval-prompt/prompt.js';
import { SPLITBRIEF_DIR } from '../../../core/paths.js';
import { wrapHard } from '../../../utils/wrap.js';
import {
  MIN_TEXT_WIDTH,
  approvalTextWidth,
  pathAwareRows,
  wrapPathAwareText,
  wrappedRows,
} from './measure.js';

const BORDER_ROWS = 2;

// Every gate is the same object to the reader — a decision SPLITBRIEF is waiting on — so the noun
// is constant and the kind rides with it. The top row then distinguishes the panels instead of
// repeating a word, and no subject line has to carry the severity a second time.
export const GATE_TITLE = 'Approval';

export function gateTitleLine(kind: string): string {
  return `${GATE_TITLE}${SOFT_SEP}${kind}`;
}

export interface KeyHint {
  key: string;
  verb: string;
}

// One legend grammar everywhere: `<key> <lowercase verb>` tokens joined by the soft separator.
// A legend carries every live key the panel does not already spell out as an option row, and
// nothing else — so a key never appears twice and none is ever left undisclosed.
export function formatKeyHints(hints: ReadonlyArray<KeyHint>): string {
  return hints.map((hint) => `${hint.key} ${hint.verb}`).join(SOFT_SEP);
}

// Escape does not dismiss a gate, it answers it: every panel resolves an escape as a denial. The
// legend says `deny` so it matches both the `Deny` option beside it and what the engine records.
export const DENY_HINT: KeyHint = { key: 'esc', verb: 'deny' };
export const CONFIRM_HINT: KeyHint = { key: 'enter', verb: 'confirm' };

export const STICKY_HINTS = formatKeyHints([DENY_HINT]);
export const CONFIRM_REASON_HINTS = formatKeyHints([CONFIRM_HINT, DENY_HINT]);
export const CONFIRM_QUESTION = 'Why are you making this change?';
export const CONFIRM_REASON_OPTIONAL = 'leave empty to record no reason';
export const IRREVERSIBLE_NOTE = 'this cannot be undone';

// The refusal replaces the legend rather than adding a row, so it has to carry the way out with
// it: the moment a user mis-keys on the most dangerous panel is not the moment to hide `esc`.
export const CONFIRM_NUDGE = `enter confirms this write${SOFT_SEP}${formatKeyHints([DENY_HINT])}`;

// The persistence disclosure is a panel-level fact, not a suffix on the `w` label: as a suffix it
// wrapped off the option row at 40 columns. It sits with the legend, in the legend's grammar, so
// it cannot be mistaken for a fifth option.
export const STICKY_PERSIST_NOTE = `w writes ${SPLITBRIEF_DIR}/approvals.json`;

// The engine rejects a confirm response with an empty reason, so a keyed confirm still
// carries one — worded so the evidence trail cannot be mistaken for a stated reason.
export const CONFIRM_REASON_UNSTATED = 'confirmed at the prompt (no reason given)';

export interface ApprovalOption {
  key: string;
  label: string;
}

export const STICKY_OPTIONS: ReadonlyArray<ApprovalOption> = [
  { key: 'a', label: 'Approve once' },
  { key: 's', label: 'Approve this session' },
  { key: 'w', label: 'Approve always' },
  { key: 'x', label: 'Deny' },
];

export function getApprovalConfirmLabel(actionClass: ActionClass): string {
  if (actionClass === 'destructive') return 'control-plane file write';
  if (actionClass === 'package_change') return 'package manifest write';
  return 'confirm file write';
}

export function isIrreversibleActionClass(actionClass: ActionClass): boolean {
  return actionClass === 'destructive';
}

// A control-plane write costs `enter`, everything else costs `y`. The split keeps the
// muscle memory built on ordinary confirmations from firing an irreversible one, and the
// word is written out rather than glyphed so it measures one column per character.
export function getConfirmPrimaryKey(actionClass: ActionClass): string {
  return isIrreversibleActionClass(actionClass) ? 'enter' : 'y';
}

export function getConfirmOptions(actionClass: ActionClass): ReadonlyArray<ApprovalOption> {
  return [
    { key: getConfirmPrimaryKey(actionClass), label: 'Confirm' },
    { key: 'r', label: 'Confirm with a reason' },
    { key: 'x', label: 'Deny' },
  ];
}

// `enter` confirms on every confirm-tier gate. On an irreversible one it is already the option
// key, so the legend stays out of its way; on a reversible one `y` owns the option row and this
// is the only place `enter` is disclosed.
export function getConfirmChooseHints(actionClass: ActionClass): string {
  return isIrreversibleActionClass(actionClass)
    ? formatKeyHints([DENY_HINT])
    : formatKeyHints([CONFIRM_HINT, DENY_HINT]);
}

export function getApprovalSeverityWord(actionClass: ActionClass): string {
  if (actionClass === 'destructive') return 'destructive';
  if (actionClass === 'package_change') return 'package';
  if (actionClass === 'network') return 'network';
  if (actionClass === 'write_out_of_scope') return 'scope';
  return 'write';
}

/**
 * Trust disclosures arrive as one line per fact. Collapsing them would run the
 * executable, its argv, and the environment note together into a single line
 * the reader has to re-parse, so the breaks survive sanitization and the row
 * math below counts them.
 */
export function formatApprovalActionDescription(actionDescription: string): string {
  return sanitizeTerminalDisplayText(actionDescription, { preserveLineBreaks: true });
}

export function approvalSubjectText(actionDescription: string, cols: number): string {
  return wrapPathAwareText(
    formatApprovalActionDescription(actionDescription),
    approvalTextWidth(cols),
  );
}

// `enter` is five columns wide and `r` is one, so the label column is set by the widest key in
// the set. Without this the destructive panel's labels stagger against its own option keys.
export function approvalKeyColumnWidth(options: ReadonlyArray<ApprovalOption>): number {
  return options.reduce((width, option) => Math.max(width, option.key.length), 0);
}

export function approvalOptionKeyCell(option: ApprovalOption, keyWidth: number): string {
  return option.key.padEnd(keyWidth);
}

// Cursor gutter + key cell + the three-space gap. A label that wraps hangs to this column so a
// continuation can never land back under the marker and read as another option.
export function approvalLabelIndent(keyWidth: number): number {
  return 2 + keyWidth + 3;
}

export function approvalOptionLabelLines(input: {
  option: ApprovalOption;
  keyWidth: number;
  width: number;
}): string[] {
  const indent = approvalLabelIndent(input.keyWidth);
  return wrapHard(input.option.label, Math.max(MIN_TEXT_WIDTH, input.width - indent)).split('\n');
}

export function approvalOptionLabelText(input: {
  option: ApprovalOption;
  keyWidth: number;
  width: number;
}): string {
  const indent = ' '.repeat(approvalLabelIndent(input.keyWidth));
  return approvalOptionLabelLines(input).join(`\n${indent}`);
}

export const APPROVAL_OPTION_FIRST_ROW_OFFSET = 4;

/** The blank rows a sticky panel paints: two above the options, one below them. */
export const STICKY_SPACER_ROWS = 3;
/** Of those, the ones that sit above the options, so shedding them moves the option rows up. */
const STICKY_LEAD_SPACER_ROWS = 2;

/**
 * What a region shorter than the panel takes from it. The blank rows go first, top down: a clipped
 * panel loses its bottom border, the note that `w` writes to disk, and the `esc deny` legend —
 * three things the reader cannot answer the gate without. Whitespace is the only row that says
 * nothing, so it is the only row that pays.
 */
export function stickySpacersShed(promptRows: number, boxRows: number): number {
  return Math.min(Math.max(0, promptRows - boxRows), STICKY_SPACER_ROWS);
}

/** How far up shedding those blanks moves the option rows. */
export function stickyLeadShed(spacersShed: number): number {
  return Math.min(spacersShed, STICKY_LEAD_SPACER_ROWS);
}

export interface PromptOptionZone {
  key: string;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export function stickyRequestRowCount(actionDescription: string, cols: number): number {
  return pathAwareRows(formatApprovalActionDescription(actionDescription), approvalTextWidth(cols));
}

function approvalOptionRowCount(
  options: ReadonlyArray<ApprovalOption>,
  width: number,
  keyWidth: number,
): number {
  return options.reduce(
    (rows, option) => rows + approvalOptionLabelLines({ option, keyWidth, width }).length,
    0,
  );
}

export function getApprovalOptionZones(input: {
  boxTop: number;
  cols: number;
  promptRows: number;
  subjectRows: number;
  options: ReadonlyArray<ApprovalOption>;
  leadShed?: number;
}): PromptOptionZone[] {
  const width = approvalTextWidth(input.cols);
  const keyWidth = approvalKeyColumnWidth(input.options);
  const left = 1;
  const right = Math.max(1, input.cols);
  const boxBottom = input.boxTop + input.promptRows - 1;
  const zones: PromptOptionZone[] = [];
  let offset = APPROVAL_OPTION_FIRST_ROW_OFFSET + input.subjectRows - (input.leadShed ?? 0);
  for (const option of input.options) {
    const optionRows = approvalOptionLabelLines({ option, keyWidth, width }).length;
    const top = input.boxTop + offset;
    const bottom = top + optionRows - 1;
    offset += optionRows;
    if (bottom > boxBottom) break;
    zones.push({ key: option.key, left, right, top, bottom });
  }
  return zones;
}

export function getStickyOptionZones(input: {
  boxTop: number;
  cols: number;
  promptRows: number;
  actionDescription: string;
  leadShed?: number;
}): PromptOptionZone[] {
  return getApprovalOptionZones({
    boxTop: input.boxTop,
    cols: input.cols,
    promptRows: input.promptRows,
    subjectRows: stickyRequestRowCount(input.actionDescription, input.cols),
    options: STICKY_OPTIONS,
    ...(input.leadShed === undefined ? {} : { leadShed: input.leadShed }),
  });
}

export function confirmSubjectRowCount(input: {
  actionClass: ActionClass;
  actionDescription: string;
  cols: number;
}): number {
  const { actionClass, actionDescription, cols } = input;
  const width = approvalTextWidth(cols);
  return (
    wrappedRows(getApprovalConfirmLabel(actionClass), width) +
    stickyRequestRowCount(actionDescription, cols) +
    (isIrreversibleActionClass(actionClass) ? wrappedRows(IRREVERSIBLE_NOTE, width) : 0)
  );
}

export function getConfirmOptionZones(input: {
  boxTop: number;
  cols: number;
  promptRows: number;
  actionClass: ActionClass;
  actionDescription: string;
}): PromptOptionZone[] {
  return getApprovalOptionZones({
    boxTop: input.boxTop,
    cols: input.cols,
    promptRows: input.promptRows,
    subjectRows: confirmSubjectRowCount({
      actionClass: input.actionClass,
      actionDescription: input.actionDescription,
      cols: input.cols,
    }),
    options: getConfirmOptions(input.actionClass),
  });
}

function getStickyRows(actionClass: ActionClass, actionDescription: string, cols: number): number {
  const width = approvalTextWidth(cols);
  return (
    BORDER_ROWS +
    wrappedRows(gateTitleLine(getApprovalSeverityWord(actionClass)), width) +
    1 +
    stickyRequestRowCount(actionDescription, cols) +
    1 +
    approvalOptionRowCount(STICKY_OPTIONS, width, approvalKeyColumnWidth(STICKY_OPTIONS)) +
    1 +
    wrappedRows(STICKY_PERSIST_NOTE, width) +
    wrappedRows(STICKY_HINTS, width)
  );
}

function getConfirmRows(actionClass: ActionClass, actionDescription: string, cols: number): number {
  const width = approvalTextWidth(cols);
  const options = getConfirmOptions(actionClass);
  const subjectRows =
    wrappedRows(gateTitleLine(getApprovalSeverityWord(actionClass)), width) +
    1 +
    confirmSubjectRowCount({ actionClass, actionDescription, cols }) +
    1;
  const chooseStepRows =
    subjectRows +
    approvalOptionRowCount(options, width, approvalKeyColumnWidth(options)) +
    1 +
    Math.max(
      wrappedRows(getConfirmChooseHints(actionClass), width),
      wrappedRows(CONFIRM_NUDGE, width),
    );
  const reasonStepRows =
    subjectRows +
    wrappedRows(CONFIRM_QUESTION, width) +
    1 +
    wrappedRows(CONFIRM_REASON_OPTIONAL, width) +
    1 +
    wrappedRows(CONFIRM_REASON_HINTS, width);
  return BORDER_ROWS + Math.max(chooseStepRows, reasonStepRows);
}

export function getApprovalPromptRows(state: ApprovalPromptState, cols: number): number {
  if (state.status !== 'pending') return 0;
  return state.request.tier === 'sticky'
    ? getStickyRows(state.request.actionClass, state.request.actionDescription, cols)
    : getConfirmRows(state.request.actionClass, state.request.actionDescription, cols);
}
