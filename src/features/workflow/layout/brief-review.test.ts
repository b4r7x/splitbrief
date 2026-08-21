import { describe, expect, it } from 'vitest';
import { getSimpleBriefReviewChromeRows, getSimpleBriefTaskRowBudget } from './brief-review.js';

describe('simple Brief review ledger rows', () => {
  it('reserves four chrome rows, and a fifth for the load-error notice', () => {
    expect(getSimpleBriefReviewChromeRows({ hasLoadError: false })).toBe(4);
    expect(getSimpleBriefReviewChromeRows({ hasLoadError: true })).toBe(5);
  });

  it('budgets Brief rows from the container height minus the ledger chrome', () => {
    expect(getSimpleBriefTaskRowBudget({ containerHeight: 16, hasLoadError: false })).toBe(12);
    expect(getSimpleBriefTaskRowBudget({ containerHeight: 16, hasLoadError: true })).toBe(11);
    expect(getSimpleBriefTaskRowBudget({ containerHeight: 2, hasLoadError: false })).toBe(0);
  });
});
