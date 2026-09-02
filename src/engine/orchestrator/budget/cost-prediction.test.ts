import { describe, it, expect } from 'vitest';
import { makeModelCacheAccessor } from '#testing/helpers/factories/model-cache.js';
import { predictCost, type PredictCostOptions } from './cost-prediction.js';
import { makeUsage } from '#testing/helpers/factories/summary.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makePricedModelCache } from '#testing/helpers/factories/model-cache.js';

// Pricing follows the model, so a metered seat needs a catalog to rate against.
const cache = makePricedModelCache();

function predict(opts: PredictCostOptions) {
  return predictCost({ cache, ...opts });
}

describe('predictCost', () => {
  it('returns zero costs for zero tasks', () => {
    const result = predict({
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
    const result = predict({
      taskCount: 10,
      plannerTool: 'custom-planner-api',
      plannerModel: 'claude-sonnet-5',
      implementerTool: 'custom-worker-api',
      implementerModel: 'deepseek-v4-flash',
    });
    expect(result.lowCost).toBeLessThan(result.expectedCost);
    expect(result.expectedCost).toBeLessThan(result.highCost);
  });

  it('computes prediction with a subscription planner and a metered implementer', () => {
    const result = predict({
      taskCount: 5,
      plannerTool: 'claude-code',
      implementerTool: 'custom-worker-api',
      implementerModel: 'deepseek-v4-flash',
    });
    expect(result.estimatedTasks).toBe(5);
    expect(result.plannerTool).toBe('claude-code');
    expect(result.implementerTool).toBe('custom-worker-api');
    expect(result.lowCost).toBeGreaterThan(0);
    expect(result.expectedCost).toBeGreaterThan(0);
    expect(result.highCost).toBeGreaterThan(0);
  });

  it('returns zero prediction for known tools when both paths are unpriced', () => {
    const result = predict({
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
    const withUsage = predict({
      taskCount: 5,
      plannerTool: 'custom-planner-api',
      implementerTool: 'ollama',
      plannerModel: 'claude-sonnet-5',
      tokenUsage,
    });
    const withoutUsage = predict({
      taskCount: 5,
      plannerTool: 'custom-planner-api',
      implementerTool: 'ollama',
      plannerModel: 'claude-sonnet-5',
    });

    expect(withUsage.lowCost).not.toBe(withoutUsage.lowCost);
  });

  it('prices nothing for unknown tools that name no model', () => {
    const result = predict({
      taskCount: 3,
      plannerTool: 'unknown-tool',
      implementerTool: 'another-unknown',
    });
    expect(result.lowCost).toBe(0);
    expect(result.expectedCost).toBe(0);
    expect(result.highCost).toBe(0);
  });

  it('consults the model-pricing cache instead of dropping it (live models.dev pricing)', () => {
    // The rate must come from the cache the caller passes, never from a constant
    // baked into the predictor: the same seat and the same model priced against a
    // dearer catalog must predict more, and against no catalog must price nothing.
    const baseOpts: PredictCostOptions = {
      taskCount: 5,
      plannerTool: 'custom-planner-api',
      plannerModel: 'claude-opus-5',
      implementerTool: 'ollama',
    };

    const dearerCatalog = makeModelCacheAccessor({
      catalog: {
        anthropic: {
          id: 'anthropic',
          models: {
            'claude-opus-5': {
              id: 'claude-opus-5',
              cost: { input: 99, output: 199 },
              limit: { context: 1_000_000 },
            },
          },
        },
      },
    });

    const uncatalogued = predict({ ...baseOpts, cache: makeModelCacheAccessor() });
    const standard = predict(baseOpts);
    const dearer = predict({ ...baseOpts, cache: dearerCatalog });

    expect(uncatalogued.expectedCost).toBe(0);
    expect(standard.expectedCost).toBeGreaterThan(0);
    expect(dearer.expectedCost).toBeGreaterThan(standard.expectedCost);
    expect(dearer.lowCost).toBeGreaterThan(standard.lowCost);
    expect(dearer.highCost).toBeGreaterThan(standard.highCost);
  });

  it('clamps negative taskCount to zero', () => {
    const result = predict({
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
      plannerTool: 'custom-planner-api',
      plannerModel: 'claude-sonnet-5',
      implementerTool: 'ollama',
    } satisfies PredictCostOptions;

    const withReviewerTokens = predict({
      ...base,
      tokenUsage: makeUsage({
        plannerInput: 10_000,
        plannerOutput: 5_000,
        reviewerInput: 10_000,
        reviewerOutput: 5_000,
      }),
      config: makeConfig(),
    });
    const asPlannerTokens = predict({
      ...base,
      tokenUsage: makeUsage({ plannerInput: 20_000, plannerOutput: 10_000 }),
    });

    expect(withReviewerTokens.expectedCost).toBeCloseTo(asPlannerTokens.expectedCost, 10);
  });

  it('prices reviewer usage at the reviewer rate when a reviewer is configured', () => {
    const base = {
      taskCount: 5,
      plannerTool: 'custom-planner-api',
      plannerModel: 'claude-sonnet-5',
      implementerTool: 'ollama',
    } satisfies PredictCostOptions;
    const usage = makeUsage({
      plannerInput: 10_000,
      plannerOutput: 5_000,
      reviewerInput: 10_000,
      reviewerOutput: 5_000,
    });

    const withReviewer = predict({
      ...base,
      tokenUsage: usage,
      config: makeConfig({
        reviewer: {
          kind: 'api',
          provider: 'custom-worker-api',
          model: 'deepseek-v4-flash',
          apiBase: 'https://api.deepseek.com',
        },
      }),
    });
    const foldedIntoPlanner = predict({ ...base, tokenUsage: usage, config: makeConfig() });
    const plannerOnly = predict({
      ...base,
      tokenUsage: makeUsage({ plannerInput: 10_000, plannerOutput: 5_000 }),
    });

    expect(withReviewer.expectedCost).toBeGreaterThan(plannerOnly.expectedCost);
    expect(withReviewer.expectedCost).toBeLessThan(foldedIntoPlanner.expectedCost);
  });

  it('leaves the prediction unchanged when no reviewer is configured', () => {
    const opts = {
      taskCount: 5,
      plannerTool: 'custom-planner-api',
      plannerModel: 'claude-sonnet-5',
      implementerTool: 'custom-worker-api',
      implementerModel: 'deepseek-v4-flash',
      tokenUsage: makeUsage({ plannerInput: 10_000, plannerOutput: 5_000 }),
    } satisfies PredictCostOptions;

    expect(predict({ ...opts, config: makeConfig() })).toEqual(predict(opts));
  });
});
