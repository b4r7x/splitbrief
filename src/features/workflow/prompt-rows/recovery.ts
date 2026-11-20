import type { RecoveryIssue } from '../../../core/schemas/recovery/schemas.js';
import { isAskedDetail, isRecoveryQuestion } from '../../../core/recovery/causes.js';
import {
  clipPromptBodyRows,
  countPromptBodyRows,
  promptBodyRows,
  type PromptBodyLine,
} from './body.js';
import { recoveryPromptSummaryRows, type PromptRow } from '../recovery/prompt-text.js';
import { getChromeContentWidth } from '../layout/chrome-rows.js';
import { getTerminalCellWidth } from '../../../utils/display-text/width.js';
import { listRowLead } from '../../../components/list-row/lead.js';
import { planListRows, type ListLine } from '../../../components/list-row/plan.js';
import { recoveryMenuRows } from '../recovery/menu-label.js';
import { runViewStore } from '../../../stores/workflow/run-view.js';
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
  const actions = recoveryMenuRows(issue, view.briefs, view.reviewNone);
  const actionRows = Math.max(1, planListRows(actions, { width }).length);
  return (
    RECOVERY_PROMPT_BORDER_ROWS +
    summaryRows +
    RECOVERY_PROMPT_SEPARATOR_ROWS +
    actionRows +
    RECOVERY_PROMPT_LEGEND_ROWS
  );
}

interface RecoveryMenuFit {
  innerWidth: number;
  framed: boolean;
  summary: PromptRow[];
  summaryRows: number;
  legend: boolean;
  divided: boolean;
  listRows: number;
  question?: { lines: string[]; height: number; width: number };
}

/** Keep the question readable and at least the selected action in view on a short terminal. */
export function fitRecoveryMenu(input: {
  issue: RecoveryIssue;
  width: number;
  boxRows: number;
  actionLines: ListLine[];
}): RecoveryMenuFit {
  const { issue, width, boxRows } = input;
  const innerWidth = Math.max(MIN_TEXT_WIDTH, width - RECOVERY_PROMPT_HORIZONTAL_CHROME);
  const fullSummary = recoveryPromptSummaryRows(issue, innerWidth);
  const fullRows = promptBodyRows(fullSummary, innerWidth);
  const actionCount = Math.max(input.actionLines.length, 1);
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
  const visibleSummary = (menu: RecoveryMenuFit) =>
    clipPromptBodyRows(promptBodyRows(menu.summary, innerWidth), menu.summaryRows);
  let menu = fitted(boxRows >= 1 + listFloor + 1 + RECOVERY_PROMPT_BORDER_ROWS);
  if (menu.framed && fullRows.some(askedRow) && !visibleSummary(menu).some(askedRow)) {
    const bare = fitted(false);
    if (visibleSummary(bare).some(askedRow)) menu = bare;
  }
  if (menu.summaryRows >= fullRows.length) return menu;
  const questions =
    issue.reason === 'plan-questions-exhausted'
      ? issue.details
      : issue.details.filter(isRecoveryQuestion);
  const headline = fullSummary[0];
  if (!questions.length || !headline) return menu;
  // A one-row panel puts the selected action beside the question.
  const inline = boxRows === 1;
  const actionWidth = inline
    ? Math.min(
        Math.ceil(innerWidth / 2),
        Math.max(
          1,
          ...input.actionLines.map((line) =>
            getTerminalCellWidth(listRowLead('active') + line.keyCell + line.name),
          ),
        ),
      )
    : 0;
  const questionWidth = inline ? Math.max(1, innerWidth - actionWidth - 1) : innerWidth;
  const questionRows = promptBodyRows(
    [headline, { kind: 'facts', items: questions, grid: false }],
    questionWidth,
  ).flatMap((row) => (row.kind === 'facts-line' ? [row.text] : []));
  const shown = visibleSummary(menu).flatMap((row) =>
    row.kind === 'facts-line' ? [row.text] : [],
  );
  if (shown.join('\n').includes(questionRows.join('\n'))) return menu;

  const paged = questionRows.length > boxRows - 1;
  const legend = boxRows >= (paged ? 3 : questionRows.length + 2);
  const summaryRows = Number(boxRows >= (paged ? 5 : questionRows.length + 3));
  const spare = boxRows - summaryRows - Number(legend);
  const framed = spare >= questionRows.length + listFloor + RECOVERY_PROMPT_BORDER_ROWS;
  const available = spare - (framed ? RECOVERY_PROMPT_BORDER_ROWS : 0);
  const height = inline ? 1 : Math.max(0, Math.min(questionRows.length, available - 1));
  return {
    innerWidth,
    framed,
    summary: [headline],
    summaryRows,
    legend,
    divided: false,
    listRows: Math.max(1, available - height),
    question: { lines: questionRows, height, width: questionWidth },
  };
}
