import { beforeEach, describe, expect, it } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeCostBreakdown } from '#testing/helpers/factories/cost-breakdown.js';
import { configStore } from '../../stores/project/config.js';
import { modelCacheStore } from '../../stores/discovery/model-cache.js';
import { tokensStore } from '../../stores/workflow/tokens.js';
import { tasksStore } from '../../stores/workflow/tasks.js';
import { formatCost } from '../../core/formatting.js';
import { formatCostDisplay, formatSpentText, readCostText } from './cost-text.js';

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
