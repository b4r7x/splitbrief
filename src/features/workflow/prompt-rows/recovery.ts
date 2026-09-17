import type { RecoveryIssue } from '../../../core/schemas/recovery/schemas.js';
import { countPromptBodyRows } from '../prompt-body-rows.js';
import { formatRecoveryPromptSummary, getRecoveryPromptActions } from '../recovery-prompt.js';
import { MIN_TEXT_WIDTH } from './measure.js';

const RECOVERY_PROMPT_HORIZONTAL_CHROME = 4;
const RECOVERY_PROMPT_BORDER_ROWS = 2;
const RECOVERY_PROMPT_SEPARATOR_ROWS = 1;
const RECOVERY_PROMPT_LEGEND_ROWS = 1;

/** Full height for the inline picker, including the scrollable action/candidate list. */
export function getRecoveryPromptRows(issue: RecoveryIssue, cols: number): number {
  const width = Math.max(MIN_TEXT_WIDTH, cols - RECOVERY_PROMPT_HORIZONTAL_CHROME);
  const summaryRows = Math.max(1, countPromptBodyRows(formatRecoveryPromptSummary(issue), width));
  const actionRows = Math.max(1, getRecoveryPromptActions(issue).length);
  const candidateRows = issue.switchSeat?.candidates.length ?? 0;
  return (
    RECOVERY_PROMPT_BORDER_ROWS +
    summaryRows +
    RECOVERY_PROMPT_SEPARATOR_ROWS +
    Math.max(actionRows, candidateRows) +
    RECOVERY_PROMPT_LEGEND_ROWS
  );
}
