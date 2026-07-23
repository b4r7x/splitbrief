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
});

describe('readCostText', () => {
  beforeEach(() => {
    modelCacheStore.reset();
    tasksStore.__testReset({ totalTasks: 1 });
    tokensStore.__testReset({
      localCount: 1,
      tokenUsage: {
        plannerInput: 0,
        plannerOutput: 0,
        implementerInput: 1_000_000,
        implementerOutput: 1_000_000,
        escalationInput: 0,
        escalationOutput: 0,
      },
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
      tokenUsage: {
        plannerInput: 0,
        plannerOutput: 0,
        implementerInput: 1_000_000,
        implementerOutput: 0,
        implementerCacheRead: 1_000_000,
        escalationInput: 0,
        escalationOutput: 0,
      },
      localCount: 1,
      escalatedCount: 0,
      totalTasks: 1,
      modelCache,
    });

    expect(costBreakdown?.totalActualCost).toBeCloseTo(1.2);
    expect(costBreakdown?.providerCosts?.anthropic?.cost).toBeCloseTo(1.0);
    expect(costBreakdown?.providerCosts?.openai?.cost).toBeCloseTo(0.2);
    expect(costBreakdown?.totalActualCost).not.toBeCloseTo(2.2);
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
      tokenUsage: {
        plannerInput: 0,
        plannerOutput: 0,
        implementerInput: 0,
        implementerOutput: 0,
        implementerCacheRead: 1_000_000,
        escalationInput: 0,
        escalationOutput: 0,
      },
      localCount: 1,
      escalatedCount: 0,
      totalTasks: 1,
      modelCache,
    });

    expect(costBreakdown?.providerCosts?.anthropic?.cost).toBeCloseTo(0.1);
    expect(costBreakdown?.providerCosts?.openai?.cost ?? 0).toBe(0);
    expect(costBreakdown?.totalActualCost).not.toBeCloseTo(0.2);
  });
});
