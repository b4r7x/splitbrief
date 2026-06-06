import { describe, expect, it } from 'vitest';
import { calculateCost, calculateUsageCost } from './cost-math.js';
import { resolvePricing } from './pricing-resolver.js';

describe('calculateCost', () => {
  it('returns 0 for unpriced providers', () => {
    const pricing = resolvePricing('claude-code', undefined, 'opus');
    expect(pricing.isPriced).toBe(false);
    expect(calculateCost(500_000, 500_000, pricing)).toBe(0);
  });

  it('calculates priced API usage', () => {
    const pricing = resolvePricing('anthropic', undefined, 'claude-sonnet-4-6');
    expect(calculateCost(1_000_000, 1_000_000, pricing)).toBe(18);
  });
});

describe('calculateUsageCost', () => {
  it('includes cache read and create costs when known', () => {
    const pricing = resolvePricing('anthropic', undefined, 'claude-sonnet-4-6');
    expect(
      calculateUsageCost({
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheReadTokens: 1_000_000,
        cacheCreateTokens: 1_000_000,
        pricing,
      }),
    ).toBeCloseTo(22.05, 10);
  });

  it('returns zero for unknown models with unpriced fallback', () => {
    const pricing = resolvePricing('unknown-provider', undefined, 'totally-unknown-model');
    expect(
      calculateUsageCost({
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheReadTokens: 1_000_000,
        cacheCreateTokens: 1_000_000,
        pricing,
      }),
    ).toBe(0);
  });
});
