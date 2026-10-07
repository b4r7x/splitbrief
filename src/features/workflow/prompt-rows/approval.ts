import { getTerminalCellWidth, sanitizeTerminalDisplayText } from '../../../utils/display-text.js';
import { SOFT_SEP } from '../../../core/separators.js';
import { fitKeyLegend } from '../../../core/key-legend.js';
import type { ActionClass, Phase } from '../../../core/schemas/enums.js';
import type { ApprovalPromptState } from '../../../stores/approval-prompt/prompt.js';
import { PLAN_JSON_FILE } from '../../../core/paths.js';
import { wrapHard } from '../../../utils/wrap.js';
import { MARK_SLOT_CELLS } from '../../../components/row-leading.js';
import { countNoun } from '../../../utils/pluralize.js';
import { REVIEW_DECORATION_ROWS } from '../layout/rect.js';
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

// One selection grammar for both gate panels: the rows move under `↑↓` and settle on `⏎`. A panel
// that holds the keyboard keeps its letters live as accelerators; the plan card leaves the keyboard
// to the composer, where a letter is text, so its rows carry none. Only one gate panel is ever on
// screen, so this legend is the single place either of them teaches the keys.
export const SELECT_HINT: KeyHint = { key: '↑↓', verb: 'select' };
export const CHOOSE_HINTS = formatKeyHints([SELECT_HINT, { key: '⏎', verb: 'confirm' }, DENY_HINT]);
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

export type ReviewArtifact = 'plan';

// An old run parked at `reviewing-spec` or `reviewing-briefs` still opens at rest, but the plan
// card is the only live gate.
export function reviewArtifactForPhase(phase: Phase): ReviewArtifact | null {
  return phase === 'reviewing-plan' ? 'plan' : null;
}

export type ReviewDocumentCommand = 'approve' | 'comment' | 'edit-file' | 'end-run';

export interface ReviewDocumentRow {
  label: string;
  command: ReviewDocumentCommand;
}

// Approving releases the build, and the row says so: that is what approving does to the run. The
// card shows plan.md, which is rendered from plan.json, so Edit opens plan.json and the engine
// checks and compiles it again.
export function reviewDocumentOptions(artifact: ReviewArtifact): ReadonlyArray<ReviewDocumentRow> {
  return [
    { label: `Approve ${artifact} and start the build`, command: 'approve' },
    { label: 'Request changes (type what to change)', command: 'comment' },
    { label: `Edit ${PLAN_JSON_FILE}`, command: 'edit-file' },
    // A document gate opens before any brief of its plan has run, so the row promises no kept
    // changes: it says what the stop menu says at the same gate.
    { label: 'End run (close this run)', command: 'end-run' },
  ];
}

export function reviewDocumentRowLines(row: ReviewDocumentRow, width: number): string[] {
  return wrapHard(row.label, Math.max(MIN_TEXT_WIDTH, width - MARK_SLOT_CELLS)).split('\n');
}

/** The confirms line opens on the key column, under the cursor gutter of the rows below it. */
export const REVIEW_CONFIRMS_INDENT = 2;

/**
 * The line that keeps what approving confirms in view while the plan scrolls: the card's body can
 * be one row tall, and these operations are what `y` grants beyond the plan itself. Counted, it
 * names how many: the plan lists each one under Protected operations, right under its summary.
 * Listed, the line breaks after a `, ` only; an operation wider than the line wraps inside itself.
 */
function reviewConfirmsText(
  confirms: readonly string[],
  width: number,
  form: 'listed' | 'counted',
): string | null {
  if (confirms.length === 0) return null;
  const lineWidth = Math.max(MIN_TEXT_WIDTH, width - REVIEW_CONFIRMS_INDENT);
  if (form === 'counted') {
    return wrapPathAwareText(
      `Approving also confirms ${countNoun(confirms.length, 'protected operation')}`,
      lineWidth,
    );
  }
  const lines: string[] = [];
  confirms.forEach((operation, index) => {
    const unit = `${index === 0 ? 'Approving also confirms: ' : ''}${operation}${index < confirms.length - 1 ? ',' : ''}`;
    const last = lines.at(-1);
    if (last !== undefined && getTerminalCellWidth(`${last} ${unit}`) <= lineWidth) {
      lines[lines.length - 1] = `${last} ${unit}`;
    } else {
      lines.push(...wrapPathAwareText(unit, lineWidth).split('\n'));
    }
  });
  return lines.join('\n');
}

export const REVIEW_DOCUMENT_HINTS = formatKeyHints([SELECT_HINT, { key: '⏎', verb: 'confirm' }]);

// While a comment is being typed the rows take no keys, so the panel names the two that are live.
export const REVIEW_COMMENT_HINTS = formatKeyHints([
  { key: '⏎', verb: 'send' },
  { key: 'esc', verb: 'back' },
]);

// Below this the panel draws no border: a box around a gate whose document has a few columns left
// is decoration.
export const REVIEW_DOCUMENT_COMPACT_COLS = 80;

export interface ReviewDocumentForm {
  /** The bold border and the blank row above the legend. */
  framed: boolean;
  legend: boolean;
  /** What approving also confirms, wrapped to the panel; null when it confirms nothing. */
  confirmsText: string | null;
}

function reviewDocumentFormRows(form: ReviewDocumentForm, artifact: ReviewArtifact, cols: number) {
  const width = approvalTextWidth(cols);
  const options = reviewDocumentOptions(artifact);
  return (
    (form.framed ? BORDER_ROWS + 1 : 0) +
    (form.confirmsText === null ? 0 : form.confirmsText.split('\n').length) +
    options.reduce((rows, option) => rows + reviewDocumentRowLines(option, width).length, 0) +
    (form.legend ? wrappedRows(REVIEW_DOCUMENT_HINTS, width) : 0)
  );
}

/**
 * The panel the plan card can afford in `budgetRows` (`getReviewPanelBudget`): the first form that
 * leaves the plan its rows. The row that says least goes first: the border and its blank, then the
 * legend (every option names what it does), then the list of what approving confirms, which
 * falls back to its count. Past that the options stay, and the body yields the plan. The border
 * and the legend are decoration, so they also leave the plan REVIEW_DECORATION_ROWS.
 */
export function reviewDocumentForm(input: {
  artifact: ReviewArtifact;
  confirms: readonly string[];
  cols: number;
  budgetRows: number;
}): ReviewDocumentForm {
  const width = approvalTextWidth(input.cols);
  const listed = reviewConfirmsText(input.confirms, width, 'listed');
  const fewest = {
    framed: false,
    legend: false,
    confirmsText: reviewConfirmsText(input.confirms, width, 'counted'),
  };
  const forms: ReviewDocumentForm[] = [
    ...(input.cols < REVIEW_DOCUMENT_COMPACT_COLS
      ? []
      : [{ framed: true, legend: true, confirmsText: listed }]),
    { framed: false, legend: true, confirmsText: listed },
    { framed: false, legend: false, confirmsText: listed },
    fewest,
  ];
  return (
    forms.find(
      (form) =>
        reviewDocumentFormRows(form, input.artifact, input.cols) <=
        input.budgetRows - (form.framed || form.legend ? REVIEW_DECORATION_ROWS : 0),
    ) ?? fewest
  );
}

export function getReviewDocumentPromptRows(
  artifact: ReviewArtifact | null,
  confirms: readonly string[],
  cols: number,
  budgetRows: number,
): number {
  if (artifact === null) return 0;
  return reviewDocumentFormRows(
    reviewDocumentForm({ artifact, confirms, cols, budgetRows }),
    artifact,
    cols,
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

/** The blank rows the confirm panel paints: two above the options, one below them. */
export const PROMPT_SPACER_ROWS = 3;
/** Of those, the ones that sit above the options, so shedding them moves the option rows up. */
const PROMPT_LEAD_SPACER_ROWS = 2;

/**
 * What a region shorter than the panel takes from it. The blank rows go first, top down: a clipped
 * panel loses its bottom border and its legend — the two things the reader cannot answer the gate
 * without. Whitespace is the only row that says nothing, so it is the only row that pays.
 */
export function promptSpacersShed(promptRows: number, boxRows: number): number {
  return Math.min(Math.max(0, promptRows - boxRows), PROMPT_SPACER_ROWS);
}

/** How far up shedding those blanks moves the option rows. */
export function promptLeadShed(spacersShed: number): number {
  return Math.min(spacersShed, PROMPT_LEAD_SPACER_ROWS);
}

export interface PromptOptionZone {
  key: string;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export function approvalSubjectRowCount(actionDescription: string, cols: number): number {
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

export function confirmSubjectRowCount(input: {
  actionClass: ActionClass;
  actionDescription: string;
  cols: number;
}): number {
  const { actionClass, actionDescription, cols } = input;
  const width = approvalTextWidth(cols);
  return (
    wrappedRows(getApprovalConfirmLabel(actionClass), width) +
    approvalSubjectRowCount(actionDescription, cols) +
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
      wrappedRows(fitKeyLegend(CHOOSE_HINTS, width), width),
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
  return getConfirmRows(state.request.actionClass, state.request.actionDescription, cols);
}
