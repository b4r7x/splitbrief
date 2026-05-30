import { describe, expect, it } from 'vitest';
import type { Config } from '../../../core/schemas/config.js';
import type { ProjectContext } from '../../../core/state/types.js';
import type { ModelCacheAccessor } from '../../providers/model/resolution.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { estimateDeterministicCost } from './estimate.js';

const context: ProjectContext = {
  name: 'test-project',
  dir: '/repo',
  runtime: 'node',
  testCommand: 'npm test',
};

const nullCache: ModelCacheAccessor = {
  getModelsDevCatalog: () => null,
  getProviderModels: () => null,
};

function withProfiles(config: Config, profiles: Config['implementerProfiles']): Config {
  return {
    ...config,
    ...(profiles !== undefined && { implementerProfiles: profiles }),
  };
}

describe('estimateDeterministicCost', () => {
  it('is stable and does not require runnable planner or implementer commands', () => {
    const config = withProfiles(
      makeConfig({
        planner: { kind: 'shell', command: 'missing-planner-command', model: 'planner-model' },
        implementer: {
          kind: 'agent',
          command: 'missing-implementer-command',
          model: 'worker-model',
        },
      }),
      {
        default: 'agent-worker',
        profiles: {
          'agent-worker': {
            kind: 'agent',
            command: 'missing-implementer-command',
            model: 'worker-model',
            contextLength: 20_000,
            costTier: 'standard',
          },
        },
      },
    );
    const task = makeTask();

    const first = estimateDeterministicCost({
      tasks: [task],
      context,
      config,
      pricingCache: nullCache,
    });
    const second = estimateDeterministicCost({
      tasks: [task],
      context,
      config,
      pricingCache: nullCache,
    });

    expect(second).toEqual(first);
    expect(first.tasks[0]).toMatchObject({
      taskId: task.id,
      selectedProfileId: 'agent-worker',
      contextFit: 'fits',
      contextConfidence: 'context-explicit',
    });
  });

  it('computes prompt-only implementer, all-planner, and savings estimates when prices are known', () => {
    const config = withProfiles(
      makeConfig({
        planner: {
          kind: 'api',
          provider: 'anthropic',
          apiBase: 'https://api.anthropic.com/v1',
          model: 'claude-opus-4-6',
        },
      }),
      {
        default: 'cheap-worker',
        profiles: {
          'cheap-worker': {
            kind: 'api',
            provider: 'deepseek',
            apiBase: 'https://api.deepseek.com/v1',
            apiKey: 'test-key',
            model: 'deepseek-chat',
            contextLength: 20_000,
            costTier: 'cheap',
          },
        },
      },
    );

    const estimate = estimateDeterministicCost({
      tasks: [makeTask()],
      context,
      config,
      pricingCache: nullCache,
    });
    const task = estimate.tasks[0];

    expect(task?.priceConfidence).toBe('price-known');
    expect(task?.estimatedImplementerCost).toBeCloseTo(
      ((task?.estimatedPromptTokens ?? 0) * 0.28) / 1_000_000,
      12,
    );
    expect(task?.hypotheticalPlannerCost).toBeCloseTo(
      ((task?.estimatedPromptTokens ?? 0) * 5) / 1_000_000,
      12,
    );
    expect(estimate.totals.knownActualEstimate).toBe(task?.estimatedImplementerCost);
    expect(estimate.totals.hypotheticalAllPlanner).toBe(task?.hypotheticalPlannerCost);
    expect(estimate.totals.estimatedSavings).toBeGreaterThan(0);
    expect(estimate.totals.unknownCostReason).toEqual([]);
  });

  it('marks unknown implementer prices without reporting fake zero cost', () => {
    const config = withProfiles(
      makeConfig({
        planner: {
          kind: 'api',
          provider: 'anthropic',
          apiBase: 'https://api.anthropic.com/v1',
          model: 'claude-opus-4-6',
        },
      }),
      {
        default: 'unknown-worker',
        profiles: {
          'unknown-worker': {
            kind: 'api',
            provider: 'custom-cloud',
            apiBase: 'https://models.example/v1',
            apiKey: 'test-key',
            model: 'custom-model',
            contextLength: 20_000,
            costTier: 'unknown',
          },
        },
      },
    );

    const estimate = estimateDeterministicCost({
      tasks: [makeTask()],
      context,
      config,
      pricingCache: nullCache,
    });

    expect(estimate.tasks[0]).toMatchObject({
      selectedProfileId: 'unknown-worker',
      priceConfidence: 'price-unknown',
      estimatedImplementerCost: null,
    });
    expect(estimate.totals.knownActualEstimate).toBeNull();
    expect(estimate.totals.unknownCostReason).toContain('implementer-price-unknown');
  });

  it('uses cached provider context length metadata when profile context length is omitted', () => {
    const pricingCache: ModelCacheAccessor = {
      getModelsDevCatalog: () => null,
      getProviderModels: (providerId) =>
        providerId === 'deepseek'
          ? [{ id: 'runtime-only', contextLength: 12_000, pricingInput: 1, pricingOutput: 2 }]
          : null,
    };
    const config = withProfiles(
      makeConfig({
        planner: {
          kind: 'api',
          provider: 'anthropic',
          apiBase: 'https://api.anthropic.com/v1',
          model: 'claude-opus-4-6',
        },
      }),
      {
        default: 'runtime-worker',
        profiles: {
          'runtime-worker': {
            kind: 'api',
            provider: 'deepseek',
            apiBase: 'https://api.deepseek.com/v1',
            apiKey: 'test-key',
            model: 'runtime-only',
            costTier: 'cheap',
          },
        },
      },
    );

    const estimate = estimateDeterministicCost({
      tasks: [makeTask()],
      context,
      config,
      pricingCache,
    });

    expect(estimate.tasks[0]).toMatchObject({
      selectedProfileId: 'runtime-worker',
      contextConfidence: 'context-cached-provider',
      priceConfidence: 'price-known',
    });
  });

  it('uses the conservative context fallback when no context length metadata is available', () => {
    const config = withProfiles(makeConfig(), {
      default: 'fallback-worker',
      profiles: {
        'fallback-worker': {
          kind: 'api',
          provider: 'custom-cloud',
          apiBase: 'https://models.example/v1',
          apiKey: 'test-key',
          model: 'unknown-model',
          costTier: 'unknown',
        },
      },
    });

    const estimate = estimateDeterministicCost({
      tasks: [makeTask()],
      context,
      config,
      pricingCache: nullCache,
      conservativeContextLength: 20_000,
    });

    expect(estimate.tasks[0]).toMatchObject({
      selectedProfileId: 'fallback-worker',
      contextFit: 'fits',
      contextConfidence: 'context-conservative-fallback',
    });
  });

  it('classifies tasks that exceed all profile context windows as overflow', () => {
    const config = withProfiles(makeConfig(), {
      default: 'tiny-worker',
      profiles: {
        'tiny-worker': {
          kind: 'api',
          provider: 'deepseek',
          apiBase: 'https://api.deepseek.com/v1',
          model: 'deepseek-chat',
          contextLength: 10,
          costTier: 'cheap',
        },
      },
    });

    const estimate = estimateDeterministicCost({
      tasks: [makeTask()],
      context,
      config,
      pricingCache: nullCache,
    });

    expect(estimate.tasks[0]).toMatchObject({
      selectedProfileId: null,
      contextFit: 'overflow',
      priceConfidence: 'profile-unavailable',
      estimatedImplementerCost: null,
    });
    expect(estimate.totals.unknownCostReason).toContain('profile-unavailable');
  });

  it('does not crash when configured profiles cannot be resolved', () => {
    const config = withProfiles(makeConfig(), {
      default: 'missing-worker',
      profiles: {
        'other-worker': {
          kind: 'api',
          provider: 'deepseek',
          apiBase: 'https://api.deepseek.com/v1',
          model: 'deepseek-chat',
          contextLength: 20_000,
        },
      },
    }) as Config;

    const estimate = estimateDeterministicCost({
      tasks: [makeTask()],
      context,
      config,
      pricingCache: nullCache,
    });

    expect(estimate.tasks[0]).toMatchObject({
      selectedProfileId: null,
      contextFit: 'unknown',
      contextConfidence: 'profile-unavailable',
      priceConfidence: 'profile-unavailable',
    });
  });
});
