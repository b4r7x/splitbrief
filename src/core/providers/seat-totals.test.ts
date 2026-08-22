import { describe, expect, it } from 'vitest';
import { splitSeatTokenTotals } from './seat-totals.js';
import { makeUsage } from '#testing/helpers/factories/summary.js';

const usage = makeUsage({
  plannerInput: 100_000,
  plannerOutput: 40_000,
  escalationInput: 10_000,
  escalationOutput: 2_000,
  plannerCacheRead: 500,
  plannerCacheCreate: 200,
  reviewerInput: 20_000,
  reviewerOutput: 5_000,
  reviewerCacheRead: 300,
  reviewerCacheCreate: 100,
});

describe('splitSeatTokenTotals', () => {
  it('folds reviewer tokens into the planner seat when the reviewer has no identity of its own', () => {
    const seats = splitSeatTokenTotals({ tokenUsage: usage, reviewerTool: undefined });

    expect(seats.reviewer).toBeUndefined();
    expect(seats.planner).toEqual({
      input: 130_000,
      output: 47_000,
      cacheRead: 800,
      cacheCreate: 300,
    });
  });

  it('keeps reviewer tokens on their own seat once the reviewer has an identity', () => {
    const seats = splitSeatTokenTotals({ tokenUsage: usage, reviewerTool: 'deepseek' });

    expect(seats.planner).toEqual({
      input: 110_000,
      output: 42_000,
      cacheRead: 500,
      cacheCreate: 200,
    });
    expect(seats.reviewer).toEqual({
      input: 20_000,
      output: 5_000,
      cacheRead: 300,
      cacheCreate: 100,
    });
  });
});
