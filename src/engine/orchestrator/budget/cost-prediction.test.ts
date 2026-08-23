import { describe, it, expect } from 'vitest';
import { makeModelCacheAccessor } from '#testing/helpers/factories/model-cache.js';
import { predictCost, type PredictCostOptions } from './cost-prediction.js';
import { makeUsage } from '#testing/helpers/factories/summary.js';
import { makeConfig } from '#testing/helpers/factories/config.js';

describe('predictCost', () => {
  it('returns zero costs for zero tasks', () => {
    const result = predictCost({
      taskCount: 0,
      plannerTool: 'claude-code',
      implementerTool: 'ollama',
    });
    expect(result.estimatedTasks).toBe(0);
    expect(result.lowCost).toBe(0);
    expect(result.expectedCost).toBe(0);
    expect(result.highCost).toBe(0);
  });

  it('produces low < expected < high for priced planner and implementer', () => {
    const result = predictCost({
      taskCount: 10,
      plannerTool: 'anthropic',
      plannerModel: 'claude-sonnet-4-6',
      implementerTool: 'deepseek',
    });
    expect(result.lowCost).toBeLessThan(result.expectedCost);
    expect(result.expectedCost).toBeLessThan(result.highCost);
  });

  it('computes prediction with known tools (claude-code + deepseek)', () => {
    const result = predictCost({
      taskCount: 5,
      plannerTool: 'claude-code',
      implementerTool: 'deepseek',
    });
    expect(result.estimatedTasks).toBe(5);
    expect(result.plannerTool).toBe('claude-code');
    expect(result.implementerTool).toBe('deepseek');
    expect(result.lowCost).toBeGreaterThan(0);
    expect(result.expectedCost).toBeGreaterThan(0);
    expect(result.highCost).toBeGreaterThan(0);
  });

  it('returns zero prediction for known tools when both paths are unpriced', () => {
    const result = predictCost({
      taskCount: 5,
      plannerTool: 'claude-code',
      implementerTool: 'ollama',
    });
    expect(result.estimatedTasks).toBe(5);
    expect(result.plannerTool).toBe('claude-code');
    expect(result.implementerTool).toBe('ollama');
    expect(result.lowCost).toBe(0);
    expect(result.expectedCost).toBe(0);
    expect(result.highCost).toBe(0);
  });

  it('uses actual planner token usage when provided', () => {
    const tokenUsage = makeUsage({ plannerInput: 10000, plannerOutput: 5000 });
    const withUsage = predictCost({
      taskCount: 5,
      plannerTool: 'anthropic',
      implementerTool: 'ollama',
      plannerModel: 'claude-sonnet-4-6',
      tokenUsage,
    });
    const withoutUsage = predictCost({
      taskCount: 5,
      plannerTool: 'anthropic',
      implementerTool: 'ollama',
      plannerModel: 'claude-sonnet-4-6',
    });

    expect(withUsage.lowCost).not.toBe(withoutUsage.lowCost);
  });

  it('falls back to local pricing for unknown tools', () => {
    const result = predictCost({
      taskCount: 3,
      plannerTool: 'unknown-tool',
      implementerTool: 'another-unknown',
    });
    expect(result.lowCost).toBe(0);
    expect(result.expectedCost).toBe(0);
    expect(result.highCost).toBe(0);
  });

  it('consults the model-pricing cache instead of dropping it (live models.dev pricing)', () => {
    // Without a cache, the anthropic planner resolves to its bundled-fallback price.
    // A cache that reports a much higher models.dev price for the same model must change the
    // prediction — proving opts.cache is threaded through to resolvePricing and not dropped.
    const baseOpts: PredictCostOptions = {
      taskCount: 5,
      plannerTool: 'anthropic',
      plannerModel: 'claude-opus-4-6',
      implementerTool: 'ollama',
    };

    const cache = makeModelCacheAccessor({
      catalog: {
        anthropic: {
          id: 'anthropic',
          models: {
            'claude-opus-4-6': {
              id: 'claude-opus-4-6',
              cost: { input: 99, output: 199 },
              limit: { context: 1_000_000 },
            },
          },
        },
      },
    });

    const withoutCache = predictCost(baseOpts);
    const withCache = predictCost({ ...baseOpts, cache });

    expect(withoutCache.expectedCost).toBeGreaterThan(0);
    expect(withCache.expectedCost).toBeGreaterThan(withoutCache.expectedCost);
    expect(withCache.lowCost).toBeGreaterThan(withoutCache.lowCost);
    expect(withCache.highCost).toBeGreaterThan(withoutCache.highCost);
  });

  it('clamps negative taskCount to zero', () => {
    const result = predictCost({
      taskCount: -5,
      plannerTool: 'claude-code',
      implementerTool: 'ollama',
    });
    expect(result.estimatedTasks).toBe(0);
    expect(result.lowCost).toBe(0);
    expect(result.expectedCost).toBe(0);
    expect(result.highCost).toBe(0);
  });

  it('prices reviewer usage at the planner rate when no reviewer is configured', () => {
    const base = {
      taskCount: 5,
      plannerTool: 'anthropic',
      plannerModel: 'claude-sonnet-4-6',
      implementerTool: 'ollama',
    } satisfies PredictCostOptions;

    const withReviewerTokens = predictCost({
      ...base,
      tokenUsage: makeUsage({
        plannerInput: 10_000,
        plannerOutput: 5_000,
        reviewerInput: 10_000,
        reviewerOutput: 5_000,
      }),
      config: makeConfig(),
    });
    const asPlannerTokens = predictCost({
      ...base,
      tokenUsage: makeUsage({ plannerInput: 20_000, plannerOutput: 10_000 }),
    });

    expect(withReviewerTokens.expectedCost).toBeCloseTo(asPlannerTokens.expectedCost, 10);
  });

  it('prices reviewer usage at the reviewer rate when a reviewer is configured', () => {
    const base = {
      taskCount: 5,
      plannerTool: 'anthropic',
      plannerModel: 'claude-sonnet-4-6',
      implementerTool: 'ollama',
    } satisfies PredictCostOptions;
    const usage = makeUsage({
      plannerInput: 10_000,
      plannerOutput: 5_000,
      reviewerInput: 10_000,
      reviewerOutput: 5_000,
    });

    const withReviewer = predictCost({
      ...base,
      tokenUsage: usage,
      config: makeConfig({
        reviewer: {
          kind: 'api',
          provider: 'deepseek',
          model: 'deepseek-v4-flash',
          apiBase: 'https://api.deepseek.com',
        },
      }),
    });
    const foldedIntoPlanner = predictCost({ ...base, tokenUsage: usage, config: makeConfig() });
    const plannerOnly = predictCost({
      ...base,
      tokenUsage: makeUsage({ plannerInput: 10_000, plannerOutput: 5_000 }),
    });

    expect(withReviewer.expectedCost).toBeGreaterThan(plannerOnly.expectedCost);
    expect(withReviewer.expectedCost).toBeLessThan(foldedIntoPlanner.expectedCost);
  });

  it('leaves the prediction unchanged when no reviewer is configured', () => {
    const opts = {
      taskCount: 5,
      plannerTool: 'anthropic',
      plannerModel: 'claude-sonnet-4-6',
      implementerTool: 'deepseek',
      tokenUsage: makeUsage({ plannerInput: 10_000, plannerOutput: 5_000 }),
    } satisfies PredictCostOptions;

    expect(predictCost({ ...opts, config: makeConfig() })).toEqual(predictCost(opts));
  });
});
