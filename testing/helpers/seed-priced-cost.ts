import { makeConfig } from './factories/config.js';
import { configStore } from '../../src/stores/project/config.js';
import { modelCacheStore } from '../../src/stores/discovery/model-cache/state.js';
import { tokensStore } from '../../src/stores/workflow/tokens.js';
import { tasksStore } from '../../src/stores/workflow/tasks.js';
import { makeUsage } from './factories/summary.js';

const PRICED_MODEL = 'runtime-priced-model';

export function seedPricedRuntimeCost(projectDir = '/tmp/priced-cost-test'): void {
  tasksStore.__testReset({ totalTasks: 1 });
  tokensStore.__testReset({
    localCount: 1,
    tokenUsage: makeUsage({
      implementerInput: 1_000_000,
      implementerOutput: 1_000_000,
    }),
  });
  configStore.__testReset({
    projectDir,
    config: makeConfig({
      implementer: {
        kind: 'api',
        provider: 'custom-endpoint',
        model: PRICED_MODEL,
        apiBase: 'https://api.example.test/v1',
        apiKey: 'test-key',
      },
    }),
  });
  modelCacheStore.reset();
  modelCacheStore.hydrateModelsDevCatalog({
    catalog: {
      vendor: {
        id: 'vendor',
        models: { [PRICED_MODEL]: { id: PRICED_MODEL, cost: { input: 1, output: 2 } } },
      },
    },
    fetchedAt: 1,
    validatedAt: 1,
  });
}
