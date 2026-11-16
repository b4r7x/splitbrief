import { describe, expect, it } from 'vitest';
import { makeRecoveryIssue } from '#testing/helpers/factories/recovery.js';
import { PLAN_CORRECTION_GOES_AGAIN } from '../../../core/recovery/causes.js';
import { fitRecoveryMenu, getRecoveryPromptRows } from './recovery.js';
import { clipPromptBodyRows, countPromptBodyRows, promptBodyRows } from './body.js';
import { recoveryPromptSummaryRows } from '../recovery/prompt-text.js';
import { getChromeContentWidth } from '../layout/chrome-rows.js';

const LONG_TEXT = `${'greet.ts needs a locale table, but the brief names no locale source. '.repeat(4)}Which file?`;

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
    [5, { framed: false, summaryRows: 1, legend: true, divided: false, listRows: 3 }],
    [6, { framed: true, summaryRows: 1, legend: true, divided: false, listRows: 2 }],
    [8, { framed: true, summaryRows: 2, legend: true, divided: false, listRows: 3 }],
    [9, { framed: true, summaryRows: 2, legend: true, divided: true, listRows: 3 }],
  ])(
    'keeps the action rows before the summary and the chrome on a %s-row panel',
    (boxRows, kept) => {
      expect(layout(76, boxRows)).toEqual({ innerWidth: 72, ...kept });
    },
  );

  it('shows every action of a 4-action halt with a long summary on an 8-row panel', () => {
    const issue = makeRecoveryIssue({
      availableActions: ['retry-same-worker', 'switch-seat', 'skip-current-task', 'end-run'],
      details: [
        'npm test failed in src/auth/session.test.ts',
        'Expected the session to expire after 30 minutes',
        'Received a session that never expires',
        'Implementer said: I changed the expiry, but the clock is frozen in the test',
      ],
    });
    const { summary, ...fit } = fitRecoveryMenu({ issue, width: 56, boxRows: 8 });

    expect(fit).toEqual({
      innerWidth: 52,
      framed: true,
      summaryRows: 1,
      legend: true,
      divided: false,
      listRows: 4,
    });
  });

  it.each([
    ['Question: ', 4, 8],
    ['Question: ', 4, 9],
    ['Planner said: ', 4, 8],
    ['Planner said: ', 4, 9],
    ['Question: ', 3, 8],
    [PLAN_CORRECTION_GOES_AGAIN, 3, 8],
  ] as const)(
    'gives up the border before the row that starts with %s on a %i-action halt of %i rows',
    (asked, actions, boxRows) => {
      const issue = makeRecoveryIssue({
        details:
          asked === PLAN_CORRECTION_GOES_AGAIN
            ? [`Last error: ${LONG_TEXT}`, asked]
            : [`${asked}${LONG_TEXT}`, 'Last error: blocked', 'Attempts: 2'],
        availableActions:
          actions === 4
            ? ['retry-same-worker', 'decide-for-me', 'skip-current-task', 'end-run']
            : ['retry-same-worker', 'skip-current-task', 'end-run'],
      });
      const fit = fitRecoveryMenu({ issue, width: 76, boxRows });
      const shown = clipPromptBodyRows(
        promptBodyRows(fit.summary, fit.innerWidth),
        fit.summaryRows,
      );

      expect(fit).toMatchObject({ framed: false, legend: true, listRows: actions });
      expect(
        shown.some((row) => row.kind === 'facts-line' && row.text.trimStart().startsWith(asked)),
      ).toBe(true);
    },
  );

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
