import { describe, expect, it } from 'vitest';
import {
  buildProviderUsageSegment,
  calculateCost,
  calculateUsageCost,
  recordPricedUsage,
  selectPricingForContext,
} from './cost-math.js';
import type { ResolvedPricing } from './pricing-resolver.js';
import { resolvePricing } from './pricing-resolver.js';

function priced(rates: Partial<ResolvedPricing> & { name: string }): ResolvedPricing {
  return {
    inputPer1M: 0,
    outputPer1M: 0,
    isLocal: false,
    isPriced: true,
    pricingMode: 'api-priced',
    source: 'models-dev',
    ...rates,
  };
}

describe('calculateCost', () => {
  it('returns 0 for unpriced providers', () => {
    const pricing = resolvePricing('claude-code', undefined, 'opus');
    expect(pricing.isPriced).toBe(false);
    expect(calculateCost(500_000, 500_000, pricing)).toBe(0);
  });

  it('calculates priced API usage', () => {
    const pricing = priced({ name: 'claude-sonnet-5', inputPer1M: 2, outputPer1M: 10 });
    expect(calculateCost(1_000_000, 1_000_000, pricing)).toBe(12);
  });
});

describe('calculateUsageCost', () => {
  it('includes cache read and create costs when known', () => {
    const pricing = priced({
      name: 'claude-sonnet-5',
      inputPer1M: 2,
      outputPer1M: 10,
      cacheReadPer1M: 0.2,
      cacheWritePer1M: 2.5,
    });
    expect(
      calculateUsageCost({
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheReadTokens: 1_000_000,
        cacheCreateTokens: 1_000_000,
        pricing,
      }),
    ).toBeCloseTo(14.7, 10);
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

  it('uses base rates below a models.dev context tier and tier rates above it', () => {
    const pricing = priced({
      name: 'gpt-5.4',
      inputPer1M: 2.5,
      outputPer1M: 15,
      cacheReadPer1M: 0.25,
      pricingTiers: [
        {
          type: 'context',
          thresholdTokens: 272_000,
          inputPer1M: 5,
          outputPer1M: 22.5,
          cacheReadPer1M: 0.5,
        },
      ],
    });

    expect(
      calculateUsageCost({
        inputTokens: 200_000,
        outputTokens: 10_000,
        cacheReadTokens: 10_000,
        cacheCreateTokens: 0,
        pricing,
      }),
    ).toBeCloseTo(0.6525, 10);
    expect(
      calculateUsageCost({
        inputTokens: 300_000,
        outputTokens: 10_000,
        cacheReadTokens: 10_000,
        cacheCreateTokens: 0,
        pricing,
      }),
    ).toBeCloseTo(1.73, 10);
  });

  it('falls back to base fields when a matching tier omits a price', () => {
    const pricing = priced({
      name: 'partial-tier',
      inputPer1M: 2,
      outputPer1M: 10,
      pricingTiers: [{ type: 'context', thresholdTokens: 1000, inputPer1M: 4 }],
    });

    const selected = selectPricingForContext(pricing, 2000);
    expect(selected.inputPer1M).toBe(4);
    expect(selected.outputPer1M).toBe(10);
  });
});

describe('buildProviderUsageSegment', () => {
  it('keeps cache-only usage in the segment totals and provider rollup', () => {
    const pricing = priced({
      name: 'claude-sonnet-5',
      inputPer1M: 2,
      outputPer1M: 10,
      cacheReadPer1M: 0.2,
      cacheWritePer1M: 2.5,
    });
    const segment = buildProviderUsageSegment({
      tool: 'claude-code',
      model: 'claude-sonnet-5',
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 1_000_000,
      cacheCreateTokens: 0,
      pricing,
    });

    expect(segment.usageTokens).toBe(1_000_000);
    expect(segment.contextTokens).toBe(1_000_000);
    expect(segment.cost).toBeCloseTo(0.2, 10);
    expect(segment.costKnown).toBe(true);

    const providerCosts = {};
    recordPricedUsage(providerCosts, segment);
    expect(providerCosts).toEqual({
      'claude-code': {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 1_000_000,
        cost: 0.2,
      },
    });
  });

  it('marks cache-only usage unknown when the provider has no cache price', () => {
    const pricing = priced({ name: 'qwen3-coder', inputPer1M: 0.14, outputPer1M: 0.28 });
    const segment = buildProviderUsageSegment({
      tool: 'lm-studio',
      model: 'qwen3-coder',
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 1_000_000,
      cacheCreateTokens: 0,
      pricing,
    });

    expect(segment.usageTokens).toBe(1_000_000);
    expect(segment.cost).toBe(0);
    expect(segment.costKnown).toBe(false);
  });
});
