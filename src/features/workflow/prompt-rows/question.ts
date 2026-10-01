import { countPromptBodyRows } from '../prompt-body-rows.js';
import type { ClarificationQuestion } from '../../../core/schemas/question.js';
import { questionOptions } from '../../../stores/question-prompt/prompt.js';
import { getTerminalCellWidth, sanitizeTerminalDisplayText } from '../../../utils/display-text.js';
import { wrapHard } from '../../../utils/wrap.js';
import { getChromeContentWidth } from '../layout/chrome-rows.js';

export const QUESTION_PROMPT_HORIZONTAL_CHROME = 4;
export const QUESTION_ANSWER_ROWS = 2;
const DEFAULT_MARKER = ' default';

export interface QuestionRow {
  text: string;
  option?: number;
  first?: boolean;
  defaultLabel?: string;
  navigation?: boolean;
}

export function questionMenu(question: ClarificationQuestion, index: number): readonly string[] {
  return [
    ...questionOptions(question),
    ...(questionOptions(question).length > 0 ? ['Write an answer…'] : []),
    ...(index > 0 ? ['Previous question'] : []),
  ];
}

/** Both measurement and rendering consume these already-wrapped terminal rows. */
export function questionRows(
  question: ClarificationQuestion,
  index: number,
  width: number,
): QuestionRow[] {
  const clean = (text: string) => sanitizeTerminalDisplayText(text, { preserveLineBreaks: true });
  const rows: QuestionRow[] = wrapHard(clean(question.text), Math.max(1, width))
    .split('\n')
    .map((text) => ({ text }));
  rows.push({ text: '' });
  const defaultValue =
    typeof question.default === 'boolean' ? (question.default ? 'Yes' : 'No') : question.default;
  const options = questionOptions(question);
  const optionWidth = Math.max(1, width - 2);
  const markerWidth = getTerminalCellWidth(DEFAULT_MARKER);
  questionMenu(question, index).forEach((label, option) => {
    const isDefault = option < options.length && label === defaultValue;
    const lines = wrapHard(clean(label), optionWidth).split('\n');
    const lastLine = lines.at(-1) ?? '';
    if (isDefault && getTerminalCellWidth(lastLine) + markerWidth > optionWidth) {
      const tail = wrapHard(lastLine, Math.max(1, optionWidth - markerWidth))
        .split('\n')
        .at(-1);
      if (tail !== undefined) {
        const head = lastLine.slice(0, lastLine.length - tail.length);
        lines.pop();
        if (head !== '') lines.push(head);
        lines.push(tail);
      }
    }
    lines.forEach((wrapped, line) => {
      rows.push({
        text: wrapped.trimStart(),
        option,
        first: line === 0,
        ...(isDefault && line === lines.length - 1 ? { defaultLabel: 'default' } : {}),
        ...(option >= options.length ? { navigation: true } : {}),
      });
    });
  });
  return rows;
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
