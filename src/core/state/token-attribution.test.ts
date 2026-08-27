import { describe, expect, it } from 'vitest';
import { makeUsage } from '#testing/helpers/factories/summary.js';
import { attributePhaseTokenDelta } from './token-attribution.js';

describe('attributePhaseTokenDelta', () => {
  it('attributes a review-only usage change to the reviewer, not the planner', () => {
    const prev = makeUsage({ plannerInput: 500, plannerOutput: 100 });
    const curr = makeUsage({
      plannerInput: 500,
      plannerOutput: 100,
      reviewerInput: 900,
      reviewerOutput: 300,
      reviewerCacheRead: 40,
      reviewerCacheCreate: 20,
    });

    const { planner, reviewer } = attributePhaseTokenDelta({
      previous: prev,
      current: curr,
      phase: 'final-review',
    });

    expect(reviewer).toEqual({ input: 900, output: 300, cacheRead: 40, cacheCreate: 20 });
    expect(planner).toEqual({ input: 0, output: 0, cacheRead: 0, cacheCreate: 0 });
  });

  it('reports no reviewer tokens for a phase that carries no cost', () => {
    const prev = makeUsage();
    const curr = makeUsage({ reviewerInput: 900, reviewerOutput: 300 });

    const { reviewer } = attributePhaseTokenDelta({ previous: prev, current: curr, phase: 'idle' });

    expect(reviewer).toEqual({ input: 0, output: 0, cacheRead: 0, cacheCreate: 0 });
  });

  it('clamps a reviewer total that moved backwards to zero', () => {
    const prev = makeUsage({ reviewerInput: 900, reviewerOutput: 300 });
    const curr = makeUsage({ reviewerInput: 100, reviewerOutput: 50 });

    const { reviewer } = attributePhaseTokenDelta({
      previous: prev,
      current: curr,
      phase: 'final-review',
    });

    expect(reviewer).toEqual({ input: 0, output: 0, cacheRead: 0, cacheCreate: 0 });
  });
});
