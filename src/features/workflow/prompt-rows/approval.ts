import { getTerminalCellWidth, sanitizeTerminalDisplayText } from '../../../utils/display-text.js';
import { SOFT_SEP } from '../../../core/separators.js';
import { fitKeyLegend } from '../../../core/key-legend.js';
import type { ActionClass, Phase } from '../../../core/schemas/enums.js';
import type { ApprovalPromptState } from '../../../stores/approval-prompt/prompt.js';
import type { TieredApprovalRequest } from '../../../core/approval/types.js';
import { PLAN_JSON_FILE } from '../../../core/paths.js';
import { wrapHard } from '../../../utils/wrap.js';
import { MARK_SLOT_CELLS } from '../../../components/row-leading.js';
import { countNoun } from '../../../utils/pluralize.js';
import { REVIEW_DECORATION_ROWS } from '../layout/rect.js';
import { getChromeContentWidth } from '../layout/chrome-rows.js';
import { OVERLAY_FRAME_ROWS } from '../../../core/navigation/overlay-rect.js';
import type { OverlayCard } from '../../../components/overlays/overlay-panel.js';
import {
  MIN_TEXT_WIDTH,
  approvalBoxTextWidth,
  approvalTextWidth,
  pathAwareRows,
  wrapPathAwareText,
  wrappedRows,
} from './measure.js';

const BORDER_ROWS = 2;
/** The blank rows inside an overlay card's border, above its title and under its body. */
const CARD_PADDING_ROWS = OVERLAY_FRAME_ROWS - BORDER_ROWS;
/** The panel's blank rows: under the title, above the options and above the legend. */
const PANEL_GAP_ROWS = 3;

// The title states the operation the run is asking for, in the words the reader would use to
// describe it. The subject line under it carries the path or command the sentence points at, so
// no row has to repeat the other and a multi-line disclosure still has somewhere to go.
export function approvalTitle(actionClass: ActionClass): string {
  if (actionClass === 'package_change') return 'Change a package manifest:';
  if (actionClass === 'destructive') return 'Destructive action:';
  if (actionClass === 'sensitive_change') return 'Change a CI or secret file:';
  if (actionClass === 'runner_trust') return 'Trust and run a configured runner:';
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
/** The legends of the choose step: too narrow a row sheds their trailing keys. */
const CHOOSE_LEGENDS = [CHOOSE_HINTS, CONFIRM_NUDGE];

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
 * Listed operations stay whole, moving below the introduction when needed; any operation wider
 * than the line uses the counted text.
 */
function reviewConfirmsText(
  confirms: readonly string[],
  width: number,
  form: 'listed' | 'counted',
): string | null {
  if (confirms.length === 0) return null;
  const lineWidth = Math.max(MIN_TEXT_WIDTH, width - REVIEW_CONFIRMS_INDENT);
  const units = confirms.map(
    (operation, index) => `${operation}${index < confirms.length - 1 ? ',' : ''}`,
  );
  if (form === 'counted' || units.some((unit) => getTerminalCellWidth(unit) > lineWidth)) {
    return wrapPathAwareText(
      `Approving also confirms ${countNoun(confirms.length, 'protected operation')}`,
      lineWidth,
    );
  }
  const lines: string[] = [];
  let line = 'Approving also confirms:';
  for (const unit of units) {
    const next = `${line} ${unit}`;
    if (getTerminalCellWidth(next) <= lineWidth) {
      line = next;
    } else {
      lines.push(line);
      line = unit;
    }
  }
  lines.push(line);
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
  if (actionClass === 'runner_trust') return 'runner command from the project config';
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

// A runner trust stores a receipt of the exact runner and nothing else, so it asks for no reason.
export function getConfirmOptions(actionClass: ActionClass): ReadonlyArray<ApprovalOption> {
  const confirm = { key: getConfirmPrimaryKey(actionClass), label: 'Confirm' };
  const deny = { key: 'x', label: 'Deny' };
  if (actionClass === 'runner_trust') return [confirm, deny];
  return [confirm, { key: 'r', label: 'Confirm with a reason' }, deny];
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

function approvalOptionRows(options: ReadonlyArray<ApprovalOption>, width: number): number[] {
  const keyWidth = approvalKeyColumnWidth(options);
  return options.map((option) => approvalOptionLabelLines({ option, keyWidth, width }).length);
}

interface ConfirmPanelRows {
  title: number;
  label: number;
  note: number;
  options: number[];
  /** The rows that answer: the option rows, or the reason step above its legend, if taller. */
  answer: number;
  /** The taller legend: the choose step's or the reason step's. */
  legend: number;
  /** The taller step under the options gap: the options and the legend, or the reason step. */
  core: number;
}

function confirmPanelRows(actionClass: ActionClass, width: number): ConfirmPanelRows {
  const options = getConfirmOptions(actionClass);
  const optionRows = approvalOptionRows(options, width);
  const chooseLegend = Math.max(
    ...CHOOSE_LEGENDS.map((legend) => wrappedRows(fitKeyLegend(legend, width), width)),
  );
  const chooseAnswer = optionRows.reduce((rows, optionRow) => rows + optionRow, 0);
  const reason = options.some((option) => option.key === 'r');
  const reasonAnswer = reason
    ? wrappedRows(CONFIRM_QUESTION, width) + 1 + wrappedRows(CONFIRM_REASON_OPTIONAL, width)
    : 0;
  const reasonLegend = reason ? wrappedRows(CONFIRM_REASON_HINTS, width) : 0;
  return {
    title: wrappedRows(approvalTitle(actionClass), width),
    label: wrappedRows(getApprovalConfirmLabel(actionClass), width),
    note: isIrreversibleActionClass(actionClass) ? wrappedRows(IRREVERSIBLE_NOTE, width) : 0,
    options: optionRows,
    answer: Math.max(chooseAnswer, reasonAnswer),
    legend: Math.max(chooseLegend, reasonLegend),
    core: Math.max(chooseAnswer + chooseLegend, reasonAnswer + reasonLegend),
  };
}

/**
 * Where the confirm panel paints. On the workflow screen it draws its own heavy box inside the
 * gutter (`box`). On a page it is the body of a titled overlay card (`card`), whose blank rows are
 * the panel's to give back. `width` is the width every line of text wraps to.
 */
export type ConfirmFrame =
  | Readonly<{ width: number; kind: 'box' }>
  | Readonly<{ width: number; kind: 'card'; card: OverlayCard }>;

/**
 * The panel's own box, painted across `paintWidth`: the chrome content width on the run screen,
 * the terminal width on a page.
 */
export function ownConfirmFrame(paintWidth: number): ConfirmFrame {
  return { width: approvalBoxTextWidth(paintWidth), kind: 'box' };
}

/** The blank rows an overlay card keeps: its padding rows and the row under its title. */
export interface CardSpacing {
  padding: boolean;
  titleGap: boolean;
}

const NO_CARD_SPACING: CardSpacing = { padding: false, titleGap: false };
const FULL_CARD_SPACING: CardSpacing = { padding: true, titleGap: true };

/** The rows an overlay card keeps around its body: its border, its title and the blank rows kept. */
function cardRows(frame: ConfirmFrame, spacing: CardSpacing): number {
  if (frame.kind === 'box') return 0;
  return (
    BORDER_ROWS +
    wrappedRows(frame.card.title, frame.width) +
    (spacing.padding ? CARD_PADDING_ROWS : 0) +
    (spacing.titleGap ? 1 : 0)
  );
}

export interface ConfirmPanelFit {
  framed: boolean;
  card: CardSpacing;
  /** The rows the panel's own box takes: the region less the card's rows around it. */
  bodyRows: number;
  title: boolean;
  /** The blank rows kept: under the title, above the options, above the legend. */
  gaps: { title: boolean; options: boolean; legend: boolean };
  label: boolean;
  subject: string[];
  /** The cut rows of text, counted on their own row or, with no row for it, after the title. */
  hidden: number;
  markRow: boolean;
  note: boolean;
  /** How many option rows paint, from the first. */
  options: number;
  legend: boolean;
}

/**
 * What a region of `boxRows` keeps of the panel. The option rows are the answer and the title is
 * what the answer decides, so they stay longest. A card gives way first by its own blank rows: its
 * padding rows, then the row under its title; it keeps its border and title. Then the panel gives
 * way by its blank rows: the one under the title, then the one above the legend, then the one above
 * the options, so the facts run into the keys last. A framed panel with no spare row has no blank
 * row. A region too short for the framed panel without its blank rows drops the border and is
 * filled in this order:
 * the option rows, the title, the legend, the disclosure, the label, the irreversible note, the
 * blank row above the options, the blank row above the legend. The label restates the title, so
 * it gives way before any disclosure line. The disclosure gives way from the bottom, a whole line
 * at a time, because the first lines name what runs. A row under the kept lines counts the cut
 * rows, with a blank row under it, as `clipPromptBodyRows` keeps the facts off the keys. With
 * fewer than three rows for the text, or with every disclosure line in view and only the label
 * cut, the title carries the count, so no row holds the count alone. A row the whole lines leave
 * free goes to the label. A region too short for the option rows and the title drops the title,
 * then the option rows that do not fit, so no row paints or answers outside the region. The reason
 * step takes the option rows' place and keeps its legend on the same terms.
 */
export function fitConfirmPanel(input: {
  actionClass: ActionClass;
  actionDescription: string;
  frame: ConfirmFrame;
  boxRows: number;
}): ConfirmPanelFit {
  const { frame } = input;
  const rows = confirmPanelRows(input.actionClass, frame.width);
  const lines = formatApprovalActionDescription(input.actionDescription)
    .split('\n')
    .map((line) => wrapPathAwareText(line, frame.width).split('\n'));
  const subjectRows = lines.flat();
  const minRows = confirmPanelMinRows(input, frame);
  const spare = input.boxRows - minRows;
  if (spare >= 0) {
    const card = {
      titleGap: frame.kind === 'card' && spare >= 4,
      padding: frame.kind === 'card' && spare >= 4 + CARD_PADDING_ROWS,
    };
    return {
      framed: frame.kind === 'box',
      card,
      // The body holds its own blank rows only. A row the card's padding cannot take as a pair stays
      // outside the card, where the panel centres it like any odd row.
      bodyRows: minRows - cardRows(frame, NO_CARD_SPACING) + Math.min(spare, PANEL_GAP_ROWS),
      title: true,
      gaps: { title: spare >= PANEL_GAP_ROWS, options: spare >= 1, legend: spare >= 2 },
      label: true,
      subject: subjectRows,
      hidden: 0,
      markRow: false,
      note: true,
      options: rows.options.length,
      legend: true,
    };
  }
  const optionRows = rows.options.reduce((total, optionRow) => total + optionRow, 0);
  const bodyRows = input.boxRows - cardRows(frame, NO_CARD_SPACING);
  // The reason step replaces the option rows, so a taller one keeps its rows too.
  let room = bodyRows - (rows.answer - optionRows);
  let options = 0;
  for (const optionRow of rows.options) {
    if (optionRow > room) break;
    room -= optionRow;
    options += 1;
  }
  const title = room >= rows.title;
  if (title) room -= rows.title;
  const legend = room >= rows.legend;
  if (legend) room -= rows.legend;
  const textRoom = Math.max(0, room);
  // A count on its own row keeps a blank row under it, so it does not run into the options.
  const countRow = subjectRows.length > textRoom && textRoom >= 3;
  const lineRoom = countRow ? textRoom - 2 : textRoom;
  const subject: string[] = [];
  for (const line of lines) {
    if (subject.length + line.length > lineRoom) break;
    subject.push(...line);
  }
  while (subject.at(-1)?.trim() === '') subject.pop();
  const label = rows.label <= lineRoom - subject.length;
  const hidden =
    (label ? 0 : rows.label) +
    subjectRows.slice(subject.length).filter((row) => row.trim() !== '').length;
  const markRow = countRow && hidden > 0 && (label || subject.length > 0);
  room -= (label ? rows.label : 0) + subject.length + (markRow ? 1 : 0);
  const note = room - (markRow ? 1 : 0) >= rows.note;
  if (note) room -= rows.note;
  return {
    framed: false,
    card: NO_CARD_SPACING,
    bodyRows,
    title,
    gaps: { title: false, options: room >= 1, legend: room >= 2 },
    label,
    subject,
    hidden,
    markRow,
    note,
    options,
    legend,
  };
}

/** The fewest rows that keep every line of the panel in view: no blank row, no count. */
export function confirmPanelMinRows(
  request: Pick<TieredApprovalRequest, 'actionClass' | 'actionDescription'>,
  frame: ConfirmFrame,
): number {
  const rows = confirmPanelRows(request.actionClass, frame.width);
  return (
    (frame.kind === 'box' ? BORDER_ROWS : cardRows(frame, NO_CARD_SPACING)) +
    rows.title +
    rows.label +
    pathAwareRows(formatApprovalActionDescription(request.actionDescription), frame.width) +
    rows.note +
    rows.core
  );
}

/**
 * Whether a card can take the question in a region of `regionRows`: every line of it in view and
 * every key of its legends whole. The card is narrower than the panel's own box, so a legend sheds
 * a key in the card that the box still shows.
 */
export function confirmCardFits(
  request: Pick<TieredApprovalRequest, 'actionClass' | 'actionDescription'>,
  frame: Extract<ConfirmFrame, { kind: 'card' }>,
  regionRows: number,
): boolean {
  return (
    CHOOSE_LEGENDS.every((legend) => fitKeyLegend(legend, frame.width) === legend) &&
    confirmPanelMinRows(request, frame) <= regionRows
  );
}

/** The rows the whole panel takes, every blank row and disclosure line in view. */
export function getConfirmPanelRows(request: TieredApprovalRequest, frame: ConfirmFrame): number {
  return (
    confirmPanelMinRows(request, frame) +
    PANEL_GAP_ROWS +
    cardRows(frame, FULL_CARD_SPACING) -
    cardRows(frame, NO_CARD_SPACING)
  );
}

export function getApprovalPromptRows(state: ApprovalPromptState, cols: number): number {
  if (state.status !== 'pending') return 0;
  return getConfirmPanelRows(state.request, ownConfirmFrame(getChromeContentWidth(cols)));
}
