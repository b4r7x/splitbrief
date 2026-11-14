import { describe, expect, it } from 'vitest';
import { makeRecoveryIssue } from '#testing/helpers/factories/recovery.js';
import { fitRecoveryMenu, getRecoveryPromptRows } from './recovery.js';
import { countPromptBodyRows } from './body.js';
import { recoveryPromptSummaryRows } from '../recovery/prompt-text.js';
import { getChromeContentWidth } from '../layout/chrome-rows.js';

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

describe('fitRecoveryMenu', () => {
  function layout(width: number, boxRows: number) {
    const { summary, ...rest } = fitRecoveryMenu({ issue: makeRecoveryIssue(), width, boxRows });
    return rest;
  }

  it.each([36, 80, 126])(
    'gives every row a place on a panel of its full height at %s columns',
    (cols) => {
      const issue = makeRecoveryIssue();
      const width = getChromeContentWidth(cols);
      const fit = fitRecoveryMenu({ issue, width, boxRows: getRecoveryPromptRows(issue, cols) });
      const summary = recoveryPromptSummaryRows(issue, width - 4);
      expect(fit).toEqual({
        innerWidth: width - 4,
        framed: true,
        summary,
        summaryRows: countPromptBodyRows(summary, width - 4),
        legend: true,
        divided: true,
        listRows: 3,
      });
    },
  );

  it.each([
    [1, { framed: false, summaryRows: 0, legend: false, divided: false, listRows: 1 }],
    [2, { framed: false, summaryRows: 1, legend: false, divided: false, listRows: 1 }],
    [3, { framed: false, summaryRows: 1, legend: false, divided: false, listRows: 2 }],
    [4, { framed: false, summaryRows: 1, legend: true, divided: false, listRows: 2 }],
    [5, { framed: false, summaryRows: 2, legend: true, divided: false, listRows: 2 }],
    [6, { framed: true, summaryRows: 1, legend: true, divided: false, listRows: 2 }],
    [8, { framed: true, summaryRows: 2, legend: true, divided: false, listRows: 3 }],
    [9, { framed: true, summaryRows: 2, legend: true, divided: true, listRows: 3 }],
  ])('keeps an action row before the summary and the chrome on a %s-row panel', (boxRows, kept) => {
    expect(layout(76, boxRows)).toEqual({ innerWidth: 72, ...kept });
  });

  it.each([2, 5])('keeps a text width of one cell on a %s-column panel', (width) => {
    expect(layout(width, 12)).toEqual({
      innerWidth: 1,
      framed: true,
      summaryRows: 5,
      legend: true,
      divided: true,
      listRows: 3,
    });
  });
});
