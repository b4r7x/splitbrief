import { describe, expect, it } from 'vitest';
import {
  REVIEW_FRAME_ROWS,
  REVIEW_MIN_ROWS,
  getReviewContentLayout,
  getReviewPanelBudget,
  getWorkflowViewportHeight,
} from '../layout/rect.js';
import { getWorkflowPromptRows } from './workflow.js';

const INPUT_ROWS = 3;

describe('the plan card on a short terminal', () => {
  it.each([
    [60, ['write package.json']],
    [60, ['write package.json', 'write .github/workflows/ci.yml']],
    [100, ['write package.json']],
    [100, []],
  ])('leaves the plan a row at %i×18 (confirms %j)', (cols, confirms) => {
    const rows = 18;
    const promptRows = getWorkflowPromptRows({
      approvalState: { status: 'idle' },
      questionHint: null,
      review: {
        artifact: 'plan',
        confirms,
        budgetRows: getReviewPanelBudget({ rows, inputRows: INPUT_ROWS }),
      },
      cols,
    });

    expect(
      getWorkflowViewportHeight({ rows, inputRows: INPUT_ROWS, promptRows }),
    ).toBeGreaterThanOrEqual(REVIEW_MIN_ROWS);
  });
});

describe('the plan card on a standard terminal', () => {
  it('gives the plan the rows a frame and a legend would take at 80×24', () => {
    const rows = 24;
    const promptRows = getWorkflowPromptRows({
      approvalState: { status: 'idle' },
      questionHint: null,
      review: {
        artifact: 'plan',
        confirms: ['write package.json', 'write package-lock.json'],
        budgetRows: getReviewPanelBudget({ rows, inputRows: INPUT_ROWS }),
      },
      cols: 80,
    });
    const documentRows = getWorkflowViewportHeight({ rows, inputRows: INPUT_ROWS, promptRows });

    expect(getReviewContentLayout(documentRows - REVIEW_FRAME_ROWS, 33).contentHeight).toBe(5);
  });
});
