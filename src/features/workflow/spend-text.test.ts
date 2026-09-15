import { beforeEach, describe, expect, it } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeCostBreakdown } from '#testing/helpers/factories/cost-breakdown.js';
import { configStore } from '../../stores/project/config.js';
import { modelCacheStore } from '../../stores/discovery/model-cache/state.js';
import { tokensStore } from '../../stores/workflow/tokens.js';
import { formatCost } from '../../core/formatting.js';
import {
  asReactiveModelCache,
  computeCostBreakdownStats,
  formatCostDisplay,
  formatSpentText,
  readCostText,
} from './spend-text.js';
import { makeUsage } from '#testing/helpers/factories/summary.js';

/**
 * Custom endpoints price by model id, so every priced fixture states its rates
 * as models.dev catalog rows keyed on the model the seat actually ran.
 */
function seedCatalog(
  rates: Record<string, { input: number; output: number; cacheRead?: number }>,
): void {
  modelCacheStore.reset();
  modelCacheStore.hydrateModelsDevCatalog({
    catalog: {
      vendor: {
        id: 'vendor',
        models: Object.fromEntries(
          Object.entries(rates).map(([id, rate]) => [
            id,
            {
              id,
              cost: {
                input: rate.input,
                output: rate.output,
                ...(rate.cacheRead !== undefined && { cache_read: rate.cacheRead }),
              },
            },
          ]),
        ),
      },
    },
    fetchedAt: 1,
    validatedAt: 1,
  });
}

describe('formatSpentText', () => {
  const pricedBreakdown = makeCostBreakdown({
    actualImplementerCost: 12.5,
    totalActualCost: 12.5,
  });

  it('qualifies the priced spend when the actual cost is partially unknown', () => {
    expect(formatSpentText({ ...pricedBreakdown, isTotalActualCostKnown: false }, 'priced')).toBe(
      `${formatCost(12.5)} + unknown`,
    );
  });

  it('leaves the priced spend unqualified when the actual cost is fully known', () => {
    expect(formatSpentText({ ...pricedBreakdown, isTotalActualCostKnown: true }, 'priced')).toBe(
      formatCost(12.5),
    );
  });

  it('reports the subscription label instead of a dollar figure for a subscription-only run', () => {
    const breakdown = makeCostBreakdown({
      hasPricedUsage: false,
      hasUnpricedUsage: true,
      providerRunMetadata: {
        'claude-code': {
          service: 'claude-code',
          offering: 'coding-subscription',
          normalizedEndpoint: 'cli:claude',
          billing: 'subscription-included',
          asOf: '2026-07-31',
        },
      },
      offeringPresentations: {
        'claude-code': {
          costLabel: 'subscription-included',
          billingLabel: 'subscription-included',
        },
      },
    });

    expect(formatSpentText(breakdown, 'unpriced')).toBe('subscription-included');
    expect(formatCostDisplay(breakdown, 'unpriced').hasSpend).toBe(true);
  });

  it('reports the local label for a local-only run', () => {
    const breakdown = makeCostBreakdown({
      hasPricedUsage: false,
      hasUnpricedUsage: true,
      providerRunMetadata: {
        ollama: {
          service: 'ollama',
          offering: 'local',
          normalizedEndpoint: 'http://localhost:11434/v1',
          billing: 'local',
          asOf: '2026-07-31',
        },
      },
      offeringPresentations: {
        ollama: { costLabel: 'local', billingLabel: 'local' },
      },
    });

    expect(formatSpentText(breakdown, 'local')).toBe('local');
    expect(formatCostDisplay(breakdown, 'local').hasSpend).toBe(true);
  });

  it('keeps the dollar figure when a metered runner shares the run', () => {
    const breakdown = makeCostBreakdown({
      ...pricedBreakdown,
      isTotalActualCostKnown: true,
      providerRunMetadata: {
        'claude-code': {
          service: 'claude-code',
          offering: 'coding-subscription',
          normalizedEndpoint: 'cli:claude',
          billing: 'subscription-included',
          asOf: '2026-07-31',
        },
        'custom-endpoint': {
          service: 'custom-endpoint',
          offering: 'payg',
          normalizedEndpoint: 'https://api.example.test/v1',
          billing: 'api-metered',
          asOf: '2026-07-31',
        },
      },
      offeringPresentations: {
        'claude-code': {
          costLabel: 'subscription-included',
          billingLabel: 'subscription-included',
        },
        'custom-endpoint': { costLabel: formatCost(12.5), billingLabel: 'api-metered' },
      },
    });

    expect(formatSpentText(breakdown, 'priced')).toBe(formatCost(12.5));
  });
});

describe('readCostText', () => {
  beforeEach(() => {
    modelCacheStore.reset();
    tokensStore.__testReset({
      localCount: 1,
      tokenUsage: makeUsage({ implementerInput: 1_000_000, implementerOutput: 1_000_000 }),
    });
    configStore.__testReset({
      projectDir: '/tmp/read-cost-text-test',
      config: makeConfig({
        implementer: {
          kind: 'api',
          provider: 'custom-endpoint',
          model: 'priced-model',
          apiBase: 'https://api.example.test/v1',
          apiKey: 'test-key',
        },
      }),
    });
  });

  it('returns null while no priced usage has accrued', () => {
    expect(readCostText()).toBeNull();
  });

  it('returns the canonical sidebar spend figure once model pricing is known', () => {
    seedCatalog({ 'priced-model': { input: 1, output: 2 } });

    expect(readCostText()).toBe(formatCost(3));
  });

  it('says the display is off rather than a figure the screens are not showing', () => {
    seedCatalog({ 'priced-model': { input: 1, output: 2 } });
    const current = configStore.get().config;
    if (current === null) throw new Error('expected the seeded config');
    configStore.__testReset({
      projectDir: '/tmp/read-cost-text-test',
      config: { ...current, workflow: { ...current.workflow, showSpend: false } },
    });

    expect(readCostText()).toBe('spend display is off');
  });
});

describe('computeCostBreakdownStats offering presentation', () => {
  it('carries the subscription label from the cost pipeline into the byline', () => {
    const config = makeConfig({
      planner: { kind: 'cli', tool: 'claude-code' },
      implementer: { kind: 'cli', tool: 'claude-code' },
    });
    const modelCache = asReactiveModelCache(modelCacheStore.get());

    const { costBreakdown, pricingState } = computeCostBreakdownStats({
      config,
      pricingContext: null,
      perTask: {},
      tokenUsage: makeUsage({
        plannerInput: 100_000,
        plannerOutput: 50_000,
        implementerInput: 200_000,
        implementerOutput: 100_000,
      }),
      modelCache,
    });

    expect(costBreakdown?.offeringPresentations?.['claude-code']?.costLabel).toBe(
      'subscription-included',
    );
    const display = formatCostDisplay(costBreakdown, pricingState);
    expect(display.hasSpend).toBe(true);
    expect(display.spentText).toBe('subscription-included');
  });
});

describe('computeCostBreakdownStats reviewer pricing', () => {
  it('prices reviewer tokens from the recorded session identity, not the live config', () => {
    seedCatalog({
      'claude-sonnet-5': { input: 3, output: 15 },
      'review-model': { input: 0.14, output: 0.28 },
    });
    const modelCache = asReactiveModelCache(modelCacheStore.get());
    const inputs = {
      config: makeConfig({
        reviewer: {
          kind: 'api' as const,
          provider: 'review-endpoint' as const,
          model: 'review-model',
          apiBase: 'https://review.example.test/v1',
          apiKey: 'test-key',
        },
      }),
      perTask: {},
      tokenUsage: makeUsage({
        plannerInput: 100_000,
        plannerOutput: 40_000,
        reviewerInput: 20_000,
        reviewerOutput: 5_000,
      }),
      modelCache,
    };

    const recordedWithoutReviewer = computeCostBreakdownStats({
      ...inputs,
      pricingContext: {
        plannerTool: 'plan-endpoint',
        plannerModel: 'claude-sonnet-5',
        implementerTool: 'ollama',
      },
    });
    const recordedWithReviewer = computeCostBreakdownStats({
      ...inputs,
      pricingContext: {
        plannerTool: 'plan-endpoint',
        plannerModel: 'claude-sonnet-5',
        implementerTool: 'ollama',
        reviewerTool: 'review-endpoint',
        reviewerModel: 'review-model',
      },
    });

    expect(
      recordedWithoutReviewer.costBreakdown?.providerCosts?.['review-endpoint'],
    ).toBeUndefined();
    expect(
      recordedWithoutReviewer.costBreakdown?.providerCosts?.['plan-endpoint']?.inputTokens,
    ).toBe(120_000);
    expect(
      recordedWithReviewer.costBreakdown?.providerCosts?.['review-endpoint']?.inputTokens,
    ).toBe(20_000);
  });
});

describe('computeCostBreakdownStats pricing state', () => {
  it('reports an all-unpriced run as n/a when only the reviewer seat is non-local', () => {
    const modelCache = asReactiveModelCache(modelCacheStore.get());
    const inputs = {
      config: makeConfig(),
      perTask: {},
      tokenUsage: makeUsage({
        plannerInput: 100_000,
        plannerOutput: 40_000,
        implementerInput: 200_000,
        implementerOutput: 80_000,
        reviewerInput: 20_000,
        reviewerOutput: 5_000,
      }),
      modelCache,
    };

    const localOnly = computeCostBreakdownStats({
      ...inputs,
      pricingContext: { plannerTool: 'ollama', implementerTool: 'ollama' },
    });
    const withUnknownReviewer = computeCostBreakdownStats({
      ...inputs,
      pricingContext: {
        plannerTool: 'ollama',
        implementerTool: 'ollama',
        reviewerTool: 'some-unknown-endpoint',
      },
    });

    expect(localOnly.pricingState).toBe('local');
    expect(withUnknownReviewer.pricingState).toBe('n/a');
  });
});

describe('computeCostBreakdownStats task reconstruction', () => {
  const rates = {
    'fallback-model': { input: 2, output: 0, cacheRead: 0.2 },
    'task-model': { input: 1, output: 0, cacheRead: 0.1 },
  };

  function fallbackConfig() {
    return makeConfig({
      implementer: {
        kind: 'api',
        provider: 'build-endpoint',
        model: 'fallback-model',
        apiBase: 'https://build.example.test/v1',
        apiKey: 'test-key',
      },
    });
  }

  it('prices task input with the task model instead of aggregate fallback pricing', () => {
    const config = fallbackConfig();
    seedCatalog(rates);
    const modelCache = asReactiveModelCache(modelCacheStore.get());

    const { costBreakdown } = computeCostBreakdownStats({
      config,
      pricingContext: null,
      perTask: {
        T001: {
          title: 'Task',
          totalTokens: 1_000_000,
          attempts: [
            {
              method: 'local',
              implementerTokens: 1_000_000,
              escalationTokens: 0,
              retryCount: 0,
              tool: 'task-endpoint',
              model: 'task-model',
              implementerCacheReadTokens: 0,
            },
          ],
        },
      },
      tokenUsage: makeUsage({ implementerInput: 1_000_000, implementerCacheRead: 1_000_000 }),
      modelCache,
    });

    expect(costBreakdown?.totalActualCost).toBeCloseTo(1.2);
    expect(costBreakdown?.providerCosts?.['task-endpoint']?.cost).toBeCloseTo(1.0);
    expect(costBreakdown?.providerCosts?.['build-endpoint']?.cost).toBeCloseTo(0.2);
  });

  it('prices cache-only task attempts with the task model cache rate', () => {
    const config = fallbackConfig();
    seedCatalog(rates);
    const modelCache = asReactiveModelCache(modelCacheStore.get());

    const { costBreakdown } = computeCostBreakdownStats({
      config,
      pricingContext: null,
      perTask: {
        T001: {
          title: 'Cache only',
          totalTokens: 1_000_000,
          attempts: [
            {
              method: 'local',
              implementerTokens: 0,
              escalationTokens: 0,
              retryCount: 0,
              tool: 'task-endpoint',
              model: 'task-model',
              implementerCacheReadTokens: 1_000_000,
            },
          ],
        },
      },
      tokenUsage: makeUsage({ implementerCacheRead: 1_000_000 }),
      modelCache,
    });

    expect(costBreakdown?.providerCosts?.['task-endpoint']?.cost).toBeCloseTo(0.1);
    expect(costBreakdown?.providerCosts?.['build-endpoint']?.cost ?? 0).toBe(0);
  });
});
