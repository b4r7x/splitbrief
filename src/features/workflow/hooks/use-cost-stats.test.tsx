import { Text } from 'ink';
import { beforeEach, describe, expect, it } from 'vitest';
import { renderFeature, tick } from '#testing/helpers/ink.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { configStore } from '../../../stores/project/config.js';
import { modelCacheStore } from '../../../stores/discovery/model-cache.js';
import { tokensStore } from '../../../stores/workflow/tokens.js';
import { tasksStore } from '../../../stores/workflow/tasks.js';
import { useCostStats } from './use-cost-stats.js';

function Harness() {
  const stats = useCostStats();
  return <Text>{stats.pricingState}</Text>;
}

function CostHarness() {
  const stats = useCostStats();
  return <Text>{stats.costBreakdown?.totalActualCost.toFixed(2) ?? 'none'}</Text>;
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

    expect(ui.lastFrame()).toBe('priced');
    ui.unmount();
  });

  it('preserves task-specific cache tokens when reconstructing task cost breakdowns', async () => {
    modelCacheStore.setProviderModels('openai', [
      {
        id: 'runtime-priced-model',
        pricingInput: 1,
        pricingOutput: 1,
        pricingCacheRead: 0.1,
      },
    ]);
    tokensStore.__testReset({
      localCount: 1,
      tokenUsage: {
        plannerInput: 0,
        plannerOutput: 0,
        implementerInput: 1_000_000,
        implementerOutput: 0,
        implementerCacheRead: 1_000_000,
        escalationInput: 0,
        escalationOutput: 0,
      },
      perTask: {
        T001: {
          title: 'Use cached context elsewhere',
          totalTokens: 1_000_000,
          attempts: [
            {
              method: 'local',
              implementerTokens: 1_000_000,
              escalationTokens: 0,
              retryCount: 0,
              tool: 'openai',
              model: 'runtime-priced-model',
              implementerCacheReadTokens: 0,
            },
          ],
        },
      },
    });

    const ui = renderFeature(<CostHarness />);
    await tick();

    expect(ui.lastFrame()).toBe('1.10');
    ui.unmount();
  });

  it('includes cache-only task attempts when reconstructing task cost breakdowns', async () => {
    modelCacheStore.setProviderModels('openai', [
      {
        id: 'runtime-priced-model',
        pricingInput: 1,
        pricingOutput: 1,
        pricingCacheRead: 0.1,
      },
    ]);
    tokensStore.__testReset({
      localCount: 1,
      tokenUsage: {
        plannerInput: 0,
        plannerOutput: 0,
        implementerInput: 0,
        implementerOutput: 0,
        implementerCacheRead: 1_000_000,
        escalationInput: 0,
        escalationOutput: 0,
      },
      perTask: {
        T001: {
          title: 'Use cached context only',
          totalTokens: 1_000_000,
          attempts: [
            {
              method: 'local',
              implementerTokens: 0,
              escalationTokens: 0,
              retryCount: 0,
              tool: 'openai',
              model: 'runtime-priced-model',
              implementerCacheReadTokens: 1_000_000,
            },
          ],
        },
      },
    });

    const ui = renderFeature(<CostHarness />);
    await tick();

    expect(ui.lastFrame()).toBe('0.10');
    ui.unmount();
  });
});
