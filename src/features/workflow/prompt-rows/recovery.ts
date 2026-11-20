import type { RecoveryIssue } from '../../../core/schemas/recovery/schemas.js';
import { isAskedDetail } from '../../../core/recovery/causes.js';
import {
  clipPromptBodyRows,
  countPromptBodyRows,
  promptBodyRows,
  type PromptBodyLine,
} from './body.js';
import { recoveryPromptSummaryRows } from '../recovery/prompt-text.js';
import { getChromeContentWidth } from '../layout/chrome-rows.js';
import { planListRows } from '../../../components/list-row/plan.js';
import { recoveryMenuRows } from '../recovery/menu-label.js';
import { runViewStore } from '../../../stores/workflow/run-view.js';
import { selectTaskListView } from '../../../core/run-view/briefs.js';
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
  const view = runViewStore.get();
  const actions = recoveryMenuRows(
    issue,
    selectTaskListView(view.briefs).finished > 0,
    view.reviewNone,
  );
  const actionRows = Math.max(1, planListRows(actions, { width }).length);
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
 * the border and the other actions: every action shows before a second summary row does. Then a
 * second summary row for the mark, the divider, and the rest of the summary, in that order. A cut
 * that would hide the row the halt asks the user to read puts that row first, whole while it fits,
 * and the rows after it give way; the summary then takes the divider's row. When the border leaves
 * no room for that row, the border gives way before it. The list scrolls, so every action stays
 * reachable.
 */
export function fitRecoveryMenu(input: {
  issue: RecoveryIssue;
  width: number;
  boxRows: number;
  actionRows: number;
}) {
  const { issue, width, boxRows } = input;
  const innerWidth = Math.max(MIN_TEXT_WIDTH, width - RECOVERY_PROMPT_HORIZONTAL_CHROME);
  const fullSummary = recoveryPromptSummaryRows(issue, innerWidth);
  const fullRows = promptBodyRows(fullSummary, innerWidth);
  const actionCount = Math.max(input.actionRows, 1);
  const listFloor = Math.min(2, actionCount);
  const askedRow = (row: PromptBodyLine): boolean =>
    row.kind === 'facts-line' && isAskedDetail(row.text.trimStart());
  const fitted = (framed: boolean) => {
    const innerHeight = boxRows - (framed ? RECOVERY_PROMPT_BORDER_ROWS : 0);
    const summaryShown = innerHeight >= 2;
    const legend = innerHeight >= 4;
    const actionRows = Math.max(
      1,
      Math.min(actionCount, innerHeight - (summaryShown ? 1 : 0) - (legend ? 1 : 0)),
    );
    // The rows above the list: the headline and a second summary row, then the divider, then more.
    const aboveList = innerHeight - (legend ? 1 : 0) - actionRows;
    const fittedHeight = Math.min(
      Math.max(1, fullRows.length),
      Math.max(1, aboveList > 2 ? aboveList - 1 : aboveList),
    );
    const fittedDivided = aboveList - fittedHeight > 0;
    const askedFirst =
      fittedDivided &&
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
  };
  const showsAsked = (menu: ReturnType<typeof fitted>): boolean =>
    clipPromptBodyRows(promptBodyRows(menu.summary, innerWidth), menu.summaryRows).some(askedRow);
  const menu = fitted(boxRows >= 1 + listFloor + 1 + RECOVERY_PROMPT_BORDER_ROWS);
  if (!menu.framed || !fullRows.some(askedRow) || showsAsked(menu)) return menu;
  const bare = fitted(false);
  return showsAsked(bare) ? bare : menu;
}
