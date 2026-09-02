import { Text } from 'ink';
import { beforeEach, describe, expect, it } from 'vitest';
import { renderFeature, tick } from '#testing/helpers/ink.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { configStore } from '../../../stores/project/config.js';
import { modelCacheStore } from '../../../stores/discovery/model-cache/state.js';
import { tokensStore } from '../../../stores/workflow/tokens.js';
import { tasksStore } from '../../../stores/workflow/tasks.js';
import { useCostStats } from './use-cost-stats.js';
import { makeUsage } from '#testing/helpers/factories/summary.js';

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
      tokenUsage: makeUsage({ implementerInput: 1_000_000, implementerOutput: 1_000_000 }),
    });
    configStore.__testReset({
      projectDir: '/tmp/use-cost-stats-test',
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

  it('reacts when model pricing is added to the model cache', async () => {
    const ui = renderFeature(<Harness />);
    await tick();

    expect(ui.lastFrame()).toBe('n/a');

    modelCacheStore.hydrateModelsDevCatalog({
      catalog: {
        vendor: {
          id: 'vendor',
          models: { 'priced-model': { id: 'priced-model', cost: { input: 1, output: 2 } } },
        },
      },
      fetchedAt: 1,
      validatedAt: 1,
    });
    await tick();

    expect(ui.lastFrame()).toBe('priced');
    ui.unmount();
  });
});
