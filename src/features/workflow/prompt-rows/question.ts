import { countPromptBodyRows } from '../prompt-body-rows.js';
import type { ClarificationQuestion } from '../../../core/schemas/question.js';
import { questionOptions } from '../../../stores/question-prompt/prompt.js';
import { sanitizeTerminalDisplayText } from '../../../utils/display-text.js';
import { wrapHard } from '../../../utils/wrap.js';
import { getChromeContentWidth } from '../layout/chrome-rows.js';

export const QUESTION_PROMPT_HORIZONTAL_CHROME = 4;
export const QUESTION_ANSWER_ROWS = 2;

export interface QuestionRow {
  text: string;
  option?: number;
  first?: boolean;
  defaultLabel?: string;
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
  questionMenu(question, index).forEach((label, option) => {
    const suffix = option < options.length && label === defaultValue ? ' (default)' : '';
    wrapHard(clean(label + suffix), Math.max(1, width - 2))
      .split('\n')
      .forEach((wrapped, line) => {
        const text = wrapped.trimStart();
        const hasDefault = suffix !== '' && text.endsWith('(default)');
        rows.push({
          text: hasDefault ? text.slice(0, -9) : text,
          option,
          first: line === 0,
          ...(hasDefault ? { defaultLabel: '(default)' } : {}),
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
