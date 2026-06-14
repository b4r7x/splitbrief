import { afterEach, describe, expect, it } from 'vitest';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplStateWithMetadata } from '#testing/helpers/factories/workflow-state.js';
import {
  cleanupTaskProjects,
  makeTaskWorkflowContext,
} from '#testing/helpers/orchestrator-task-context.js';
import type { ResolvedImplementerProfile } from '../../../core/config/accessors/implementer-profiles.js';
import { getRunnerModelName } from '../../../core/config/accessors/runner-config.js';
import type { ModelCacheAccessor } from '../../providers/model/resolution.js';
import { selectRoutingProfile } from './routing-selection.js';

function cacheOnlyResolvableProfile(): ResolvedImplementerProfile {
  return {
    name: 'cache-worker',
    costTier: 'cheap',
    capabilities: { writesFiles: 'extracted-code' },
    isDefault: true,
    config: {
      kind: 'api',
      provider: 'openrouter',
      apiBase: 'https://openrouter.ai/api/v1',
      apiKey: 'test-key',
      model: 'runtime-only-model',
    },
  };
}

afterEach(cleanupTaskProjects);

describe('selectRoutingProfile context cache', () => {
  it('assesses a cache-resolvable model at its catalog context length, not the conservative fallback', async () => {
    const modelCache: ModelCacheAccessor = {
      getModelsDevCatalog: () => null,
      getProviderModels: (providerId) =>
        providerId === 'openrouter'
          ? [{ id: 'runtime-only-model', contextLength: 64_000, pricingInput: 1, pricingOutput: 2 }]
          : null,
    };
    const wctx = makeTaskWorkflowContext({ modelCache });
    const task = makeTask();
    const state = makeImplStateWithMetadata([task]);
    const profile = cacheOnlyResolvableProfile();

    const result = await selectRoutingProfile({
      wctx,
      state,
      setTrackedState: () => {},
      task,
      taskIndex: 0,
      resolvedProfiles: [profile],
      taskBreakdowns: [],
      getRunnerModelName,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.routingDecision.selectedProfile).toBe('cache-worker');
    expect(result.routingDecision.contextLength).toBe(64_000);
  });

  it('falls back to the conservative context length when no model cache is provided', async () => {
    const wctx = makeTaskWorkflowContext();
    const task = makeTask();
    const state = makeImplStateWithMetadata([task]);
    const profile = cacheOnlyResolvableProfile();

    const result = await selectRoutingProfile({
      wctx,
      state,
      setTrackedState: () => {},
      task,
      taskIndex: 0,
      resolvedProfiles: [profile],
      taskBreakdowns: [],
      getRunnerModelName,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.routingDecision.contextLength).toBe(8192);
  });
});
