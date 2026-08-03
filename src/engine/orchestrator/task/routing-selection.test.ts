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
      service: 'openrouter',
      offering: 'payg',
      apiBase: 'https://openrouter.ai/api/v1',
      apiKey: 'test-key',
      model: 'runtime-only-model',
    },
  };
}

function detectedFallbackProfiles(): ResolvedImplementerProfile[] {
  return [
    {
      name: 'cheap-detected-worker',
      costTier: 'cheap',
      capabilities: { writesFiles: 'extracted-code' },
      isDefault: true,
      config: {
        kind: 'agent',
        command: 'cheap-worker',
        model: 'cheap-model',
      },
    },
    {
      name: 'standard-worker',
      costTier: 'standard',
      capabilities: { writesFiles: 'extracted-code' },
      isDefault: false,
      config: {
        kind: 'agent',
        command: 'standard-worker',
        model: 'standard-model',
        contextLength: 50_000,
      },
    },
  ];
}

function largePromptTask() {
  return makeTask({ description: 'large routing input '.repeat(2000) });
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
    expect(result.selectedProfile).toEqual(profile);
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

  it('uses detected context length as the live conservative fallback so a cheaper profile can fit', async () => {
    const task = largePromptTask();
    const state = makeImplStateWithMetadata([task]);
    const profiles = detectedFallbackProfiles();

    const withoutDetected = await selectRoutingProfile({
      wctx: makeTaskWorkflowContext(),
      state,
      setTrackedState: () => {},
      task,
      taskIndex: 0,
      resolvedProfiles: profiles,
      taskBreakdowns: [],
      getRunnerModelName,
    });

    expect(withoutDetected.ok).toBe(true);
    if (!withoutDetected.ok) return;
    expect(withoutDetected.routingDecision.selectedProfile).toBe(profiles[1]!.name);
    expect(withoutDetected.routingDecision.rejected[0]).toMatchObject({
      profile: 'cheap-detected-worker',
      fit: 'overflow',
      contextLength: 8192,
    });

    const withDetected = await selectRoutingProfile({
      wctx: makeTaskWorkflowContext({ detectedContextLength: 20_000 }),
      state,
      setTrackedState: () => {},
      task,
      taskIndex: 0,
      resolvedProfiles: profiles,
      taskBreakdowns: [],
      getRunnerModelName,
    });

    expect(withDetected.ok).toBe(true);
    if (!withDetected.ok) return;
    expect(withDetected.routingDecision.selectedProfile).toBe('cheap-detected-worker');
    expect(withDetected.routingDecision.contextLength).toBe(20_000);
  });
});

describe('selectRoutingProfile recovery override', () => {
  it('uses the exact requested retry profile only for its target task', async () => {
    const task = makeTask({ id: 'T010' });
    const profiles = detectedFallbackProfiles();
    const state = makeImplStateWithMetadata([task]);

    const selected = await selectRoutingProfile({
      wctx: makeTaskWorkflowContext({
        retryProfileOverride: 'standard-worker',
        retryProfileOverrideTaskId: task.id,
      }),
      state,
      setTrackedState: () => {},
      task,
      taskIndex: 0,
      resolvedProfiles: profiles,
      taskBreakdowns: [],
      getRunnerModelName,
    });

    expect(selected.ok).toBe(true);
    if (!selected.ok) return;
    expect(selected.selectedProfile).toBe(profiles[1]);
    expect(selected.routingDecision.selectedProfile).toBe('standard-worker');

    const otherTask = makeTask({ id: 'T011' });
    const normal = await selectRoutingProfile({
      wctx: makeTaskWorkflowContext({
        retryProfileOverride: 'standard-worker',
        retryProfileOverrideTaskId: task.id,
      }),
      state: makeImplStateWithMetadata([otherTask]),
      setTrackedState: () => {},
      task: otherTask,
      taskIndex: 0,
      resolvedProfiles: profiles,
      taskBreakdowns: [],
      getRunnerModelName,
    });

    expect(normal.ok).toBe(true);
    if (!normal.ok) return;
    expect(normal.selectedProfile).toBe(profiles[0]);
    expect(normal.routingDecision.selectedProfile).toBe('cheap-detected-worker');
  });
});
