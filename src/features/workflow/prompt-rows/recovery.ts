import type { RecoveryIssue } from '../../../core/schemas/recovery/schemas.js';
import { isAskedDetail } from '../../../core/recovery/causes.js';
import {
  clipPromptBodyRows,
  countPromptBodyRows,
  promptBodyRows,
  type PromptBodyLine,
} from './body.js';
import { recoveryPromptSummaryRows } from '../recovery/prompt-text.js';
import { getRecoveryPromptActions } from '../recovery/actions.js';
import { getChromeContentWidth } from '../layout/chrome-rows.js';
import { MIN_TEXT_WIDTH } from './measure.js';

const RECOVERY_PROMPT_HORIZONTAL_CHROME = 4;
const RECOVERY_PROMPT_BORDER_ROWS = 2;
const RECOVERY_PROMPT_SEPARATOR_ROWS = 1;
const RECOVERY_PROMPT_LEGEND_ROWS = 1;

/** Full height for the inline picker, including the scrollable action list. */
export function getRecoveryPromptRows(issue: RecoveryIssue, cols: number): number {
  // The menu renders inside the screen frame, so its text measure is the framed width.
  const width = Math.max(
    MIN_TEXT_WIDTH,
    getChromeContentWidth(cols) - RECOVERY_PROMPT_HORIZONTAL_CHROME,
  );
  const summaryRows = Math.max(
    1,
    countPromptBodyRows(recoveryPromptSummaryRows(issue, width), width),
  );
  const actionRows = Math.max(1, getRecoveryPromptActions(issue).length);
  return (
    RECOVERY_PROMPT_BORDER_ROWS +
    summaryRows +
    RECOVERY_PROMPT_SEPARATOR_ROWS +
    actionRows +
    RECOVERY_PROMPT_LEGEND_ROWS
  );
}

/**
 * What a recovery menu of `width` columns keeps in a box of `boxRows`. A short panel keeps its
 * content before its chrome: the selected action, the headline (it carries the cut mark when it is
 * the only summary row), one mark row that names every side hiding actions, and the legend. Then
 * the border, a second summary row for the mark, the other actions, and the divider, in that
 * order. A cut that would hide the row the halt asks the user to read puts that row first, whole
 * while it fits, and the rows after it give way. The summary then takes the divider's row, or a
 * list row on a panel with no divider. The list scrolls, so every action stays reachable.
 */
export function fitRecoveryMenu(input: { issue: RecoveryIssue; width: number; boxRows: number }) {
  const { issue, width, boxRows } = input;
  const innerWidth = Math.max(MIN_TEXT_WIDTH, width - RECOVERY_PROMPT_HORIZONTAL_CHROME);
  const fullSummary = recoveryPromptSummaryRows(issue, innerWidth);
  const fullRows = promptBodyRows(fullSummary, innerWidth);
  const minimumListRows = Math.min(4, Math.max(getRecoveryPromptActions(issue).length, 1));
  const listFloor = Math.min(2, minimumListRows);
  const framed = boxRows >= 1 + listFloor + 1 + RECOVERY_PROMPT_BORDER_ROWS;
  const innerHeight = boxRows - (framed ? RECOVERY_PROMPT_BORDER_ROWS : 0);
  const summaryShown = innerHeight >= 2;
  const legend = innerHeight >= 4;
  const besideList = innerHeight - listFloor - 1;
  const fittedHeight = Math.min(
    Math.max(1, fullRows.length),
    Math.max(1, Math.min(2, besideList), innerHeight - minimumListRows - 2),
  );
  const fittedDivided = innerHeight - fittedHeight - minimumListRows - 1 > 0;
  const askedRow = (row: PromptBodyLine): boolean =>
    row.kind === 'facts-line' && isAskedDetail(row.text.trimStart());
  const askedFirst =
    besideList > fittedHeight &&
    fullRows.some(askedRow) &&
    !clipPromptBodyRows(fullRows, fittedHeight).some(askedRow);
  const summary = askedFirst
    ? recoveryPromptSummaryRows(issue, innerWidth, fittedHeight - 1)
    : fullSummary;
  const takesSummaryRow = askedFirst && countPromptBodyRows(summary, innerWidth) > fittedHeight;
  const summaryRows = summaryShown ? fittedHeight + (takesSummaryRow ? 1 : 0) : 0;
  const divided = fittedDivided && !takesSummaryRow;
  return {
    innerWidth,
    framed,
    summary,
    summaryRows,
    legend,
    divided,
    listRows: innerHeight - summaryRows - (legend ? 1 : 0) - (divided ? 1 : 0),
  };
}
