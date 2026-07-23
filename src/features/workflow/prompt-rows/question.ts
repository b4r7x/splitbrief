import { countPromptBodyRows } from '../prompt-body-rows.js';
import { MIN_TEXT_WIDTH } from './measure.js';

export const QUESTION_PROMPT_HORIZONTAL_CHROME = 4;
const QUESTION_PROMPT_BORDER_ROWS = 2;

export function getQuestionPromptRows(hint: string, cols: number): number {
  const width = Math.max(MIN_TEXT_WIDTH, cols - QUESTION_PROMPT_HORIZONTAL_CHROME);
  return QUESTION_PROMPT_BORDER_ROWS + Math.max(1, countPromptBodyRows(hint, width));
}
