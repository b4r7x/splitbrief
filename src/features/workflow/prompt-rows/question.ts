import { countPromptBodyRows } from '../prompt-body-rows.js';
import { MIN_TEXT_WIDTH } from './measure.js';
import type { ClarificationQuestion } from '../../../core/schemas/question.js';

export const QUESTION_PROMPT_HORIZONTAL_CHROME = 4;
const QUESTION_PROMPT_BORDER_ROWS = 2;

export function formatQuestionPrompt(
  hint: string,
  questions: readonly ClarificationQuestion[] = [],
): string {
  if (questions.length === 0) return hint;
  const lines = ['Answer the planner…'];
  for (const [index, question] of questions.entries()) {
    const details =
      question.type === 'choice' && question.options.length > 0
        ? ` · ${question.options.join(' / ')}`
        : question.type === 'confirm'
          ? ' · yes / no'
          : '';
    const defaultValue =
      question.default === undefined
        ? ''
        : ` · default ${typeof question.default === 'boolean' ? (question.default ? 'yes' : 'no') : question.default}`;
    lines.push(`${index + 1}. ${question.text}${details}${defaultValue}`);
  }
  return lines.join('\n');
}

export function getQuestionPromptRows(
  hint: string,
  cols: number,
  questions: readonly ClarificationQuestion[] = [],
): number {
  const width = Math.max(MIN_TEXT_WIDTH, cols - QUESTION_PROMPT_HORIZONTAL_CHROME);
  return (
    QUESTION_PROMPT_BORDER_ROWS +
    Math.max(1, countPromptBodyRows(formatQuestionPrompt(hint, questions), width))
  );
}
