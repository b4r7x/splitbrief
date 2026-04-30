import { useEffect } from 'react';
import { Text } from 'ink';
import { beforeEach, describe, expect, it } from 'vitest';
import { renderFeature, tick } from '#testing/helpers/ink.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { configStore } from '../../../stores/project/config.js';
import { modelCacheStore } from '../../../stores/discovery/model-cache.js';
import { tokensStore } from '../../../stores/workflow/tokens.js';
import { tasksStore } from '../../../stores/workflow/tasks.js';
import { useCostStats, type CostPricingState } from './use-cost-stats.js';

function Harness({ capture }: { capture: { current: CostPricingState | null } }) {
  const stats = useCostStats();
  useEffect(() => {
    capture.current = stats.pricingState;
  });
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
    const capture: { current: CostPricingState | null } = { current: null };
    const ui = renderFeature(<Harness capture={capture} />);
    await tick();

    expect(capture.current).toBe('n/a');
    expect(ui.lastFrame()).toBe('n/a');

    modelCacheStore.setProviderModels('openai', [{
      id: 'runtime-priced-model',
      pricingInput: 1,
      pricingOutput: 2,
    }]);
    await tick();

    expect(capture.current).toBe('mixed');
    expect(ui.lastFrame()).toBe('mixed');
    ui.unmount();
  });
});
