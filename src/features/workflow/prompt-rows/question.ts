import { planListRows } from '../../../components/list-row/plan.js';
import { countPromptBodyRows } from './body.js';
import { type ClarificationQuestion, questionDefault } from '../../../core/schemas/question.js';
import { SOFT_SEP } from '../../../core/separators.js';
import { questionOptions } from '../../../stores/prompts/question.js';
import { truncateTerminalDisplayText } from '../../../utils/display-text/truncate.js';
import { getTerminalCellWidth } from '../../../utils/display-text/width.js';
import { sanitizeTerminalDisplayText } from '../../../utils/display-text/sanitize.js';
import { wrapHard } from '../../../utils/display-text/wrap.js';
import { clamp } from '../../../utils/math.js';
import { inlineMenuChrome } from '../inline-menu/layout.js';
import { getChromeContentWidth } from '../layout/chrome-rows.js';

export const QUESTION_PROMPT_HORIZONTAL_CHROME = 4;
export const QUESTION_ANSWER_ROWS = 2;

interface QuestionRow {
  text: string;
  option?: number;
  first?: boolean;
  defaultLabel?: string;
  navigation?: boolean;
}

export function questionMenu(question: ClarificationQuestion, index: number): readonly string[] {
  return [
    ...questionOptions(question),
    ...(questionOptions(question).length > 0 ? ['Write your own answer…'] : []),
    'Decide for me',
    ...(index > 0 ? ['Previous question'] : []),
  ];
}

/** Where the Decide for me row sits in the question's menu. */
export function decideRowIndex(question: ClarificationQuestion): number {
  const options = questionOptions(question).length;
  return options > 0 ? options + 1 : 0;
}

/** Both measurement and rendering consume these already-wrapped terminal rows. */
function questionRows(
  question: ClarificationQuestion,
  index: number,
  width: number,
): QuestionRow[] {
  const clean = (text: string) => sanitizeTerminalDisplayText(text, { preserveLineBreaks: true });
  const rows: QuestionRow[] = wrapHard(clean(question.text), Math.max(1, width))
    .split('\n')
    .map((text) => ({ text }));
  rows.push({ text: '' });
  const defaultValue = questionDefault(question);
  const options = questionOptions(question);
  const items = questionMenu(question, index).map((label, option) => ({
    name: clean(label),
    wrapName: true,
    trailing: option < options.length && label === defaultValue ? 'default' : '',
  }));
  for (const line of planListRows(items, { width })) {
    rows.push({
      text: line.name,
      option: line.row,
      first: line.part === 0,
      ...(line.trailing && { defaultLabel: line.trailing }),
      ...(line.row >= options.length && { navigation: true }),
    });
  }
  return rows;
}

/**
 * What a box of `height` rows paints of the question: its rows, the answer field, the body that
 * scrolls, and the rows of the selected option.
 */
export function fitQuestionView(
  input: Readonly<{
    question: ClarificationQuestion | undefined;
    index: number;
    selected: number;
    width: number;
    height: number;
    writing: boolean;
    offset: number;
  }>,
) {
  const { question, height } = input;
  const choices = question ? questionOptions(question) : [];
  const showAnswer = input.writing || (choices.length === 0 && height > QUESTION_ANSWER_ROWS);
  const innerWidth = Math.max(1, input.width - QUESTION_PROMPT_HORIZONTAL_CHROME);
  const rows = question ? questionRows(question, input.index, innerWidth) : [];
  const chrome = inlineMenuChrome(height, showAnswer ? QUESTION_ANSWER_ROWS + 1 : 1);
  // The question keeps a row, so a short panel never shows an answer field alone.
  const answerRows = showAnswer ? clamp(chrome.listRows - 1, 1, QUESTION_ANSWER_ROWS) : 0;
  const bodyHeight = Math.max(chrome.extraRows, chrome.listRows - answerRows);
  const maxOffset = Math.max(0, rows.length - bodyHeight);
  return {
    rows,
    innerWidth,
    chrome,
    showAnswer,
    answerRows,
    bodyHeight,
    maxOffset,
    visibleOffset: clamp(input.offset, 0, maxOffset),
    first: rows.findIndex((row) => row.option === input.selected),
    last: rows.findLastIndex((row) => row.option === input.selected),
  };
}

/** The offset that shows the selected option; the answer field shows the question from its first row. */
export function followQuestionSelection(
  offset: number,
  view: Readonly<{
    first: number;
    last: number;
    bodyHeight: number;
    maxOffset: number;
    writing: boolean;
  }>,
): number {
  const { first, last, bodyHeight, maxOffset } = view;
  if (view.writing) return 0;
  if (first < offset) return Math.max(0, first);
  if (last >= offset + bodyHeight)
    return clamp(last - first >= bodyHeight ? first : last - bodyHeight + 1, 0, maxOffset);
  return clamp(offset, 0, maxOffset);
}

/**
 * The text that a fitted question paints: the scroll mark, the question beside a row that hides it,
 * each body row cut to the cells it keeps, and the answer field beside the question with no body.
 */
export function fitQuestionText(view: ReturnType<typeof fitQuestionView>, draft: string) {
  const { rows, innerWidth, chrome, bodyHeight, maxOffset, visibleOffset } = view;
  const mark = [visibleOffset > 0 ? '↑ more' : '', visibleOffset < maxOffset ? '↓ more' : '']
    .filter((word) => word !== '')
    .join(SOFT_SEP);
  const inlineMark = chrome.extraRows === 0 ? mark : '';
  const asked =
    visibleOffset > 0
      ? `${SOFT_SEP}${inlineMark === '' ? '' : `${inlineMark}${SOFT_SEP}`}${rows[0]?.text}`
      : inlineMark === ''
        ? ''
        : `${SOFT_SEP}${inlineMark}`;
  // One row holds the option and the question together: from a later offset a long option keeps at
  // most half the row, and less when its default label and the mark would not fit; at the top the
  // question keeps what the mark leaves.
  const markCells = getTerminalCellWidth(`${SOFT_SEP}${inlineMark}${SOFT_SEP}`);
  const rowText = (row: QuestionRow): string => {
    if (chrome.titled || asked === '') return row.text;
    const defaultCells = row.defaultLabel ? getTerminalCellWidth(` ${row.defaultLabel}`) : 0;
    const cut =
      visibleOffset > 0
        ? Math.min(Math.ceil(innerWidth / 2), innerWidth - 2 - defaultCells - markCells)
        : innerWidth - getTerminalCellWidth(asked);
    return truncateTerminalDisplayText(row.text.trimEnd(), Math.max(1, cut));
  };
  const answerWidth = Math.max(
    1,
    bodyHeight === 0
      ? Math.min(Math.ceil(innerWidth / 2), getTerminalCellWidth(draft) + 1)
      : innerWidth - 2,
  );
  const besideQuestion =
    bodyHeight === 0
      ? truncateTerminalDisplayText(
          `${SOFT_SEP}${mark}${SOFT_SEP}${rows[0]?.text ?? ''}`,
          Math.max(1, innerWidth - 2 - answerWidth),
        )
      : '';
  return {
    mark,
    asked,
    body: rows.slice(visibleOffset, visibleOffset + bodyHeight).map((row, index) => {
      const continues =
        index === bodyHeight - 1 &&
        row.option !== undefined &&
        rows[visibleOffset + bodyHeight]?.option === row.option;
      return {
        row,
        text: rowText(
          continues
            ? {
                ...row,
                text: truncateTerminalDisplayText(
                  row.text.trimEnd() + '…',
                  Math.max(1, innerWidth - 2),
                ),
              }
            : row,
        ),
      };
    }),
    answerWidth,
    besideQuestion,
  };
}

export function getQuestionPromptRows(
  hint: string,
  cols: number,
  questions: readonly ClarificationQuestion[] = [],
  index = 0,
  writing = false,
): number {
  // The question box renders inside the screen frame; its text measure is the framed width minus
  // the box's own border and padding, matching what the panel actually paints.
  const width = Math.max(1, getChromeContentWidth(cols) - QUESTION_PROMPT_HORIZONTAL_CHROME);
  const question = questions[index];
  // Borders, progress, overflow status and key legend remain outside the scrolling body.
  return question
    ? questionRows(question, index, width).length +
        5 +
        (writing || questionOptions(question).length === 0 ? QUESTION_ANSWER_ROWS : 0)
    : 2 + Math.max(1, countPromptBodyRows(hint, width));
}
