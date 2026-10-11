import type { RecoveryIssue } from '../../../core/schemas/recovery/schemas.js';
import { countPromptBodyRows } from '../prompt-body-rows.js';
import { recoveryPromptSummaryRows, getRecoveryPromptActions } from '../recovery-prompt.js';
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
  const summaryRows = Math.max(1, countPromptBodyRows(recoveryPromptSummaryRows(issue), width));
  const actionRows = Math.max(1, getRecoveryPromptActions(issue).length);
  return (
    RECOVERY_PROMPT_BORDER_ROWS +
    summaryRows +
    RECOVERY_PROMPT_SEPARATOR_ROWS +
    actionRows +
    RECOVERY_PROMPT_LEGEND_ROWS
  );
}
