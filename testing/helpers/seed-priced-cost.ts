import { makeConfig } from './factories/config.js';
import { configStore } from '../../src/stores/project/config.js';
import { modelCacheStore } from '../../src/stores/discovery/model-cache.js';
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
        provider: 'openai',
        model: PRICED_MODEL,
        apiBase: 'https://api.openai.test/v1',
      },
    }),
  });
  modelCacheStore.setProviderModels('openai', [
    { id: PRICED_MODEL, pricingInput: 1, pricingOutput: 2 },
  ]);
}
