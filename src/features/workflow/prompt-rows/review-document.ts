import { MARK_SLOT_CELLS } from '../../../components/row-leading.js';
import { PLAN_JSON_FILE } from '../../../core/paths.js';
import type { Phase } from '../../../core/schemas/enums.js';
import { getTerminalCellWidth } from '../../../utils/display-text/width.js';
import { wrapHard } from '../../../utils/display-text/wrap.js';
import { countNoun } from '../../../utils/pluralize.js';
import { REVIEW_DECORATION_ROWS } from '../layout/rect.js';
import { BORDER_ROWS } from './approval.js';
import { formatKeyHints, SELECT_HINT, CONFIRM_HINT } from '../../../components/key-legend.js';
import { MIN_TEXT_WIDTH, wrapPathAwareText, approvalTextWidth, wrappedRows } from './measure.js';

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
export function reviewConfirmsCount(confirms: readonly string[]): string {
  return `confirms ${countNoun(confirms.length, 'protected operation')}`;
}

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
    return wrapPathAwareText(`Approving also ${reviewConfirmsCount(confirms)}`, lineWidth);
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

export const REVIEW_TYPED_ROW_HINTS = formatKeyHints([CONFIRM_HINT, { key: 'esc', verb: 'back' }]);

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

/**
 * What a form keeps in a box of `boxRows`. The marked option is the row Enter takes, so the options
 * scroll instead of leaving, and the confirms line stays until it would take the last row.
 */
export function reviewDocumentFit(input: {
  form: ReviewDocumentForm;
  artifact: ReviewArtifact;
  cols: number;
  boxRows: number;
}) {
  const { form, artifact, cols, boxRows } = input;
  const width = approvalTextWidth(cols);
  const confirmsRows = form.confirmsText === null ? 0 : form.confirmsText.split('\n').length;
  const confirms = confirmsRows > 0 && boxRows > confirmsRows;
  const optionRows = reviewDocumentOptions(artifact).reduce(
    (rows, option) => rows + reviewDocumentRowLines(option, width).length,
    0,
  );
  const missingRows = Math.max(0, reviewDocumentFormRows(form, artifact, cols) - boxRows);
  return { confirms, listRows: optionRows - missingRows + (confirms ? 0 : confirmsRows) };
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
