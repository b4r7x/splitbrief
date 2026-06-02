import { Text } from 'ink';
import { beforeEach, describe, expect, it } from 'vitest';
import { renderFeature, tick } from '#testing/helpers/ink.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { configStore } from '../../../stores/project/config.js';
import { modelCacheStore } from '../../../stores/discovery/model-cache.js';
import { tokensStore } from '../../../stores/workflow/tokens.js';
import { tasksStore } from '../../../stores/workflow/tasks.js';
import { formatCostDisplay, useCostStats } from './use-cost-stats.js';

function Harness() {
  const stats = useCostStats();
  return <Text>{stats.pricingState}</Text>;
}

describe('useCostStats', () => {
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
      projectDir: '/tmp/use-cost-stats-test',
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

  it('reacts when runtime model pricing is added to the model cache', async () => {
    const ui = renderFeature(<Harness />);
    await tick();

    expect(ui.lastFrame()).toBe('n/a');

    modelCacheStore.setProviderModels('openai', [
      {
        id: 'runtime-priced-model',
        pricingInput: 1,
        pricingOutput: 2,
      },
    ]);
    await tick();

    expect(ui.lastFrame()).toBe('mixed');
    ui.unmount();
  });
});

describe('formatCostDisplay', () => {
  it('hides zero-dollar savings estimates', () => {
    const display = formatCostDisplay(
      100,
      {
        hypotheticalCost: 0,
        actualPlannerCost: 0,
        actualImplementerCost: 0,
        totalActualCost: 0,
        savingsAmount: 0,
        savingsPercentage: 0,
        localCompletionRate: 1,
        hasPricedUsage: true,
        hasUnpricedUsage: false,
        hasSavingsEstimate: true,
      },
      'priced',
    );

    expect(display.showSavings).toBe(false);
  });
});
