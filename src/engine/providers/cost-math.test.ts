import { describe, expect, it } from 'vitest';
import {
  buildProviderUsageSegment,
  calculateCost,
  calculateUsageCost,
  recordPricedUsage,
  selectPricingForContext,
} from './cost-math.js';
import { resolvePricing } from './pricing-resolver.js';
import { makeModelCacheAccessor } from '#testing/helpers/factories/model-cache.js';

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

  it('uses base rates below a models.dev context tier and tier rates above it', () => {
    const pricing = resolvePricing(
      'openai',
      makeModelCacheAccessor({
        catalog: {
          openai: {
            id: 'openai',
            models: {
              'gpt-5.4': {
                id: 'gpt-5.4',
                cost: {
                  input: 2.5,
                  output: 15,
                  cache_read: 0.25,
                  tiers: [
                    {
                      input: 5,
                      output: 22.5,
                      cache_read: 0.5,
                      tier: { type: 'context', size: 272000 },
                    },
                  ],
                },
              },
            },
          },
        },
      }),
      'gpt-5.4',
    );

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
    const pricing = resolvePricing(
      'openai',
      makeModelCacheAccessor({
        providerModels: {
          openai: [
            {
              id: 'partial-tier',
              pricingInput: 2,
              pricingOutput: 10,
              pricingTiers: [{ type: 'context', thresholdTokens: 1000, inputPer1M: 4 }],
            },
          ],
        },
      }),
      'partial-tier',
    );

    const selected = selectPricingForContext(pricing, 2000);
    expect(selected.inputPer1M).toBe(4);
    expect(selected.outputPer1M).toBe(10);
  });
});

describe('buildProviderUsageSegment', () => {
  it('keeps cache-only usage in the segment totals and provider rollup', () => {
    const pricing = resolvePricing('anthropic', undefined, 'claude-sonnet-4-6');
    const segment = buildProviderUsageSegment({
      tool: 'anthropic',
      model: 'claude-sonnet-4-6',
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 1_000_000,
      cacheCreateTokens: 0,
      pricing,
    });

    expect(segment.usageTokens).toBe(1_000_000);
    expect(segment.contextTokens).toBe(1_000_000);
    expect(segment.cost).toBeCloseTo(0.3, 10);
    expect(segment.costKnown).toBe(true);

    const providerCosts = {};
    recordPricedUsage(providerCosts, segment);
    expect(providerCosts).toEqual({
      anthropic: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 1_000_000,
        cost: 0.3,
      },
    });
  });

  it('marks cache-only usage unknown when the provider has no cache price', () => {
    const pricing = resolvePricing('deepseek', undefined, 'deepseek-chat');
    const segment = buildProviderUsageSegment({
      tool: 'deepseek',
      model: 'deepseek-chat',
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
