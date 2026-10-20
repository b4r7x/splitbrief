import { describe, expect, it } from 'vitest';
import { makeRecoveryIssue } from '#testing/helpers/factories/recovery.js';
import { getRecoveryPromptRows } from './recovery.js';
import { countPromptBodyRows } from '../prompt-body-rows.js';
import { recoveryPromptSummaryRows } from '../recovery-prompt.js';

describe('getRecoveryPromptRows', () => {
  it.each([36, 126])('ignores empty detail lines at %s columns', (cols) => {
    const issue = makeRecoveryIssue({ details: ['First\n\nsecond'] });
    const withoutEmptyLine = makeRecoveryIssue({ ...issue, details: ['First\nsecond'] });
    expect(getRecoveryPromptRows(issue, cols)).toBe(getRecoveryPromptRows(withoutEmptyLine, cols));
  });

  it.each([
    [36, 30, 14],
    [126, 120, 12],
  ])('measures the rendered summary at %s columns', (cols, width, rows) => {
    const issue = makeRecoveryIssue();
    expect(getRecoveryPromptRows(issue, cols)).toBe(rows);
    expect(countPromptBodyRows(recoveryPromptSummaryRows(issue, width), width)).toBe(rows - 7);
  });

  it.each([
    [36, 12],
    [126, 9],
  ])('measures a wrapping fact-free headline at %s columns', (cols, rows) => {
    const issue = makeRecoveryIssue({
      reason: 'seat-protocol-error',
      seat: 'review',
      attempts: undefined,
      message:
        'REVIEW answer needs repair because the answer did not include any usable evidence from the required checks for this brief',
      taskId: undefined,
      taskTitle: undefined,
      files: [],
      affectedTaskIds: [],
      details: [],
    });
    expect(getRecoveryPromptRows(issue, cols)).toBe(rows);
  });
});
