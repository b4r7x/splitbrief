import { sanitizeTerminalDisplayText } from '../../../utils/display-text.js';
import { SOFT_SEP } from '../../../core/separators.js';
import { fitKeyLegend } from '../../../core/key-legend.js';
import type { ActionClass, Phase } from '../../../core/schemas/enums.js';
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

// The title states the operation the run is asking for, in the words the reader would use to
// describe it. The subject line under it carries the path or command the sentence points at, so
// no row has to repeat the other and a multi-line disclosure still has somewhere to go.
export function approvalTitle(actionClass: ActionClass): string {
  if (actionClass === 'package_change') return 'Change a package manifest:';
  if (actionClass === 'destructive') return 'Destructive action:';
  if (actionClass === 'sensitive_change') return 'Change a CI or secret file:';
  if (actionClass === 'network') return 'Network access:';
  return "Write outside the brief's declared files:";
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
export const CONFIRM_HINT: KeyHint = { key: '⏎', verb: 'confirm' };

// One selection grammar for both gate panels: the rows move under `↑↓` and settle on `⏎`, and the
// letters stay live as accelerators. Only one gate panel is ever on screen, so this legend is the
// single place either of them teaches the keys.
export const SELECT_HINT: KeyHint = { key: '↑↓', verb: 'select' };
export const STICKY_HINTS = formatKeyHints([SELECT_HINT, { key: '⏎', verb: 'confirm' }, DENY_HINT]);
export const CONFIRM_REASON_HINTS = formatKeyHints([CONFIRM_HINT, DENY_HINT]);
export const CONFIRM_QUESTION = 'Why are you making this change?';
export const CONFIRM_REASON_OPTIONAL = 'leave empty to record no reason';
export const IRREVERSIBLE_NOTE = 'this cannot be undone';

// The refusal replaces the legend rather than adding a row, so it has to carry the way out with
// it: the moment a user mis-keys on the most dangerous panel is not the moment to hide `esc`.
export const CONFIRM_NUDGE = `⏎ confirms this write${SOFT_SEP}${formatKeyHints([DENY_HINT])}`;

// The engine rejects a confirm response with an empty reason, so a keyed confirm still
// carries one — worded so the evidence trail cannot be mistaken for a stated reason.
export const CONFIRM_REASON_UNSTATED = 'confirmed at the prompt (no reason given)';

export interface ApprovalOption {
  key: string;
  label: string;
}

export const STICKY_OPTIONS: ReadonlyArray<ApprovalOption> = [
  { key: 'a', label: 'allow this operation only' },
  { key: 's', label: 'allow for this session' },
  { key: 'w', label: `allow always (writes ${SPLITBRIEF_DIR}/approvals.json)` },
  { key: 'x', label: 'deny' },
];

export type ReviewArtifact = 'spec' | 'plan' | 'briefs';

// Approving an artifact is not an end in itself — it releases the next step. Naming that step on
// the row is what tells a first-time reader what `y` actually does to the run. The plan gate opens
// once the briefs are already compiled, so the step it releases is their review.
const REVIEW_NEXT_STEP: Record<ReviewArtifact, string> = {
  spec: 'write the plan',
  plan: 'review the briefs',
  briefs: 'start the build',
};

export function reviewArtifactForPhase(phase: Phase): ReviewArtifact | null {
  if (phase === 'reviewing-spec') return 'spec';
  if (phase === 'reviewing-plan') return 'plan';
  if (phase === 'reviewing-briefs') return 'briefs';
  return null;
}

export type ReviewDocumentCommand = 'approve' | 'comment' | 'edit-file' | 'end-run';

export interface ReviewDocumentRow extends ApprovalOption {
  command: ReviewDocumentCommand;
}

export function reviewDocumentOptions(artifact: ReviewArtifact): ReadonlyArray<ReviewDocumentRow> {
  return [
    {
      key: 'y',
      label: `Approve ${artifact} and ${REVIEW_NEXT_STEP[artifact]}`,
      command: 'approve',
    },
    { key: 'c', label: 'Request changes (type what to change)', command: 'comment' },
    { key: 'e', label: 'Edit in $EDITOR', command: 'edit-file' },
    // A document gate opens before any brief of its plan has run, so the row promises no kept
    // changes: it says what the stop menu says at the same gate.
    { key: 'q', label: 'End run (close this run)', command: 'end-run' },
  ];
}

export const REVIEW_DOCUMENT_HINTS = formatKeyHints([SELECT_HINT, { key: '⏎', verb: 'confirm' }]);

// While a comment is being typed the letters are text, so the panel stops advertising them and
// names the two keys that are still live.
export const REVIEW_COMMENT_HINTS = formatKeyHints([
  { key: '⏎', verb: 'send' },
  { key: 'esc', verb: 'back' },
]);

// Below this the panel and the document it gates cannot both keep their chrome. The rows that say
// something — the options and the legend — stay; the border and the blank above it go, because a
// box drawn around a gate the reader can no longer read the document behind is decoration.
export const REVIEW_DOCUMENT_COMPACT_COLS = 80;

export function isCompactReviewDocument(cols: number): boolean {
  return cols < REVIEW_DOCUMENT_COMPACT_COLS;
}

export function getReviewDocumentPromptRows(artifact: ReviewArtifact | null, cols: number): number {
  if (artifact === null) return 0;
  const width = approvalTextWidth(cols);
  const options = reviewDocumentOptions(artifact);
  const compact = isCompactReviewDocument(cols);
  return (
    (compact ? 0 : BORDER_ROWS + 1) +
    approvalOptionRowCount(options, width, approvalKeyColumnWidth(options)) +
    wrappedRows(REVIEW_DOCUMENT_HINTS, width)
  );
}

export function getApprovalConfirmLabel(actionClass: ActionClass): string {
  if (actionClass === 'destructive') return 'control-plane file write';
  if (actionClass === 'package_change') return 'package manifest write';
  if (actionClass === 'sensitive_change') return 'CI or secret file write';
  return 'confirm file write';
}

export function isIrreversibleActionClass(actionClass: ActionClass): boolean {
  return actionClass === 'destructive';
}

// A control-plane write carries no key on its Confirm row: `y` is refused there, so the row
// takes the shared ⏎ instead of an accelerator and the key column stays one cell wide. Every
// other confirm-tier gate keeps `y` on the row.
export function getConfirmPrimaryKey(actionClass: ActionClass): string {
  return isIrreversibleActionClass(actionClass) ? '' : 'y';
}

export function getConfirmOptions(actionClass: ActionClass): ReadonlyArray<ApprovalOption> {
  return [
    { key: getConfirmPrimaryKey(actionClass), label: 'Confirm' },
    { key: 'r', label: 'Confirm with a reason' },
    { key: 'x', label: 'Deny' },
  ];
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

// The label column is set by the widest key in the set, so a row with a shorter key still aligns
// with the rest — on a destructive gate that is `r`, one cell, because Confirm carries none.
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

/** The blank rows a sticky or confirm panel paints: two above the options, one below them. */
export const STICKY_SPACER_ROWS = 3;
/** Of those, the ones that sit above the options, so shedding them moves the option rows up. */
const STICKY_LEAD_SPACER_ROWS = 2;

/**
 * What a region shorter than the panel takes from it. The blank rows go first, top down: a clipped
 * panel loses its bottom border and its legend — the two things the reader cannot answer the gate
 * without. Whitespace is the only row that says nothing, so it is the only row that pays.
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
  leadShed?: number;
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
    ...(input.leadShed === undefined ? {} : { leadShed: input.leadShed }),
  });
}

function getStickyRows(actionClass: ActionClass, actionDescription: string, cols: number): number {
  const width = approvalTextWidth(cols);
  return (
    BORDER_ROWS +
    wrappedRows(approvalTitle(actionClass), width) +
    1 +
    stickyRequestRowCount(actionDescription, cols) +
    1 +
    approvalOptionRowCount(STICKY_OPTIONS, width, approvalKeyColumnWidth(STICKY_OPTIONS)) +
    1 +
    wrappedRows(fitKeyLegend(STICKY_HINTS, width), width)
  );
}

function getConfirmRows(actionClass: ActionClass, actionDescription: string, cols: number): number {
  const width = approvalTextWidth(cols);
  const options = getConfirmOptions(actionClass);
  const subjectRows =
    wrappedRows(approvalTitle(actionClass), width) +
    1 +
    confirmSubjectRowCount({ actionClass, actionDescription, cols }) +
    1;
  const chooseStepRows =
    subjectRows +
    approvalOptionRowCount(options, width, approvalKeyColumnWidth(options)) +
    1 +
    Math.max(
      wrappedRows(fitKeyLegend(STICKY_HINTS, width), width),
      wrappedRows(fitKeyLegend(CONFIRM_NUDGE, width), width),
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
