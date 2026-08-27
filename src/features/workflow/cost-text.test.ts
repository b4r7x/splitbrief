import { beforeEach, describe, expect, it } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeCostBreakdown } from '#testing/helpers/factories/cost-breakdown.js';
import { configStore } from '../../stores/project/config.js';
import { modelCacheStore } from '../../stores/discovery/model-cache.js';
import { tokensStore } from '../../stores/workflow/tokens.js';
import { tasksStore } from '../../stores/workflow/tasks.js';
import { formatCost } from '../../core/formatting.js';
import {
  asReactiveModelCache,
  computeCostBreakdownStats,
  formatCostDisplay,
  formatSpentText,
  readCostText,
} from './cost-text.js';
import { makeUsage } from '#testing/helpers/factories/summary.js';

describe('formatCostDisplay', () => {
  it('hides zero-dollar savings estimates', () => {
    const display = formatCostDisplay(
      100,
      makeCostBreakdown({
        hasSavingsEstimate: true,
      }),
      'priced',
    );

    expect(display.showSavings).toBe(false);
  });
});

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
    expect(formatCostDisplay(100, breakdown, 'unpriced').showSpend).toBe(true);
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
    expect(formatCostDisplay(100, breakdown, 'local').showSpend).toBe(true);
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
        deepseek: {
          service: 'deepseek',
          offering: 'payg',
          normalizedEndpoint: 'https://api.deepseek.com/v1',
          billing: 'api-metered',
          asOf: '2026-07-31',
        },
      },
      offeringPresentations: {
        'claude-code': {
          costLabel: 'subscription-included',
          billingLabel: 'subscription-included',
        },
        deepseek: { costLabel: formatCost(12.5), billingLabel: 'api-metered' },
      },
    });

    expect(formatSpentText(breakdown, 'priced')).toBe(formatCost(12.5));
  });
});

describe('readCostText', () => {
  beforeEach(() => {
    modelCacheStore.reset();
    tasksStore.__testReset({ totalTasks: 1 });
    tokensStore.__testReset({
      localCount: 1,
      tokenUsage: makeUsage({ implementerInput: 1_000_000, implementerOutput: 1_000_000 }),
    });
    configStore.__testReset({
      projectDir: '/tmp/read-cost-text-test',
      config: makeConfig({
        implementer: {
          kind: 'api',
          provider: 'openai',
          model: 'runtime-priced-model',
          apiBase: 'https://api.openai.test/v1',
        },
      }),
    });
  });

  it('returns null while no priced usage has accrued', () => {
    expect(readCostText()).toBeNull();
  });

  it('returns the canonical sidebar spend figure once model pricing is known', () => {
    modelCacheStore.setProviderModels('openai', [
      { id: 'runtime-priced-model', pricingInput: 1, pricingOutput: 2 },
    ]);

    expect(readCostText()).toBe(formatCost(3));
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
      localCount: 1,
      escalatedCount: 0,
      totalTasks: 1,
      modelCache,
    });

    expect(costBreakdown?.offeringPresentations?.['claude-code']?.costLabel).toBe(
      'subscription-included',
    );
    const display = formatCostDisplay(100, costBreakdown, pricingState);
    expect(display.showSpend).toBe(true);
    expect(display.spentText).toBe('subscription-included');
  });
});

describe('computeCostBreakdownStats reviewer pricing', () => {
  it('prices reviewer tokens from the recorded session identity, not the live config', () => {
    const modelCache = asReactiveModelCache(modelCacheStore.get());
    const inputs = {
      config: makeConfig({
        reviewer: {
          kind: 'api' as const,
          provider: 'deepseek' as const,
          model: 'deepseek-v4-flash',
          apiBase: 'https://api.deepseek.com/v1',
        },
      }),
      perTask: {},
      tokenUsage: makeUsage({
        plannerInput: 100_000,
        plannerOutput: 40_000,
        reviewerInput: 20_000,
        reviewerOutput: 5_000,
      }),
      localCount: 0,
      escalatedCount: 0,
      totalTasks: 0,
      modelCache,
    };

    const recordedWithoutReviewer = computeCostBreakdownStats({
      ...inputs,
      pricingContext: {
        plannerTool: 'anthropic',
        plannerModel: 'claude-sonnet-5',
        implementerTool: 'ollama',
      },
    });
    const recordedWithReviewer = computeCostBreakdownStats({
      ...inputs,
      pricingContext: {
        plannerTool: 'anthropic',
        plannerModel: 'claude-sonnet-5',
        implementerTool: 'ollama',
        reviewerTool: 'deepseek',
        reviewerModel: 'deepseek-v4-flash',
      },
    });

    expect(recordedWithoutReviewer.costBreakdown?.providerCosts?.deepseek).toBeUndefined();
    expect(recordedWithoutReviewer.costBreakdown?.providerCosts?.anthropic?.inputTokens).toBe(
      120_000,
    );
    expect(recordedWithReviewer.costBreakdown?.providerCosts?.deepseek?.inputTokens).toBe(20_000);
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
      localCount: 0,
      escalatedCount: 0,
      totalTasks: 0,
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
  const openAiFallback = {
    id: 'fallback-model',
    pricingInput: 2,
    pricingOutput: 0,
    pricingCacheRead: 0.2,
  };
  const anthropicTask = {
    id: 'task-model',
    pricingInput: 1,
    pricingOutput: 0,
    pricingCacheRead: 0.1,
  };

  it('prices task input with the task model instead of aggregate fallback pricing', () => {
    const config = makeConfig({
      implementer: {
        kind: 'api',
        provider: 'openai',
        model: 'fallback-model',
        apiBase: 'https://api.openai.test/v1',
      },
    });
    modelCacheStore.setProviderModels('openai', [openAiFallback]);
    modelCacheStore.setProviderModels('anthropic', [anthropicTask]);
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
              tool: 'anthropic',
              model: 'task-model',
              implementerCacheReadTokens: 0,
            },
          ],
        },
      },
      tokenUsage: makeUsage({ implementerInput: 1_000_000, implementerCacheRead: 1_000_000 }),
      localCount: 1,
      escalatedCount: 0,
      totalTasks: 1,
      modelCache,
    });

    expect(costBreakdown?.totalActualCost).toBeCloseTo(1.2);
    expect(costBreakdown?.providerCosts?.anthropic?.cost).toBeCloseTo(1.0);
    expect(costBreakdown?.providerCosts?.openai?.cost).toBeCloseTo(0.2);
  });

  it('prices cache-only task attempts with the task model cache rate', () => {
    const config = makeConfig({
      implementer: {
        kind: 'api',
        provider: 'openai',
        model: 'fallback-model',
        apiBase: 'https://api.openai.test/v1',
      },
    });
    modelCacheStore.setProviderModels('openai', [openAiFallback]);
    modelCacheStore.setProviderModels('anthropic', [anthropicTask]);
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
              tool: 'anthropic',
              model: 'task-model',
              implementerCacheReadTokens: 1_000_000,
            },
          ],
        },
      },
      tokenUsage: makeUsage({ implementerCacheRead: 1_000_000 }),
      localCount: 1,
      escalatedCount: 0,
      totalTasks: 1,
      modelCache,
    });

    expect(costBreakdown?.providerCosts?.anthropic?.cost).toBeCloseTo(0.1);
    expect(costBreakdown?.providerCosts?.openai?.cost ?? 0).toBe(0);
  });
});
