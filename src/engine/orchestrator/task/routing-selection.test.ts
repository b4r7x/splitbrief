import { afterEach, describe, expect, it } from 'vitest';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplStateWithMetadata } from '#testing/helpers/factories/workflow-state.js';
import {
  cleanupTaskProjects,
  makeTaskWorkflowContext,
} from '#testing/helpers/orchestrator-task-context.js';
import type { ResolvedImplementerProfile } from '../../../core/config/accessors/implementer-profiles.js';
import { getRunnerModelName } from '../../../core/config/accessors/runner-config.js';
import { DEFAULT_UNKNOWN_CONTEXT_LENGTH } from '../../../core/tokens/context-length.js';
import { APPLICATION_DEFAULT_CONTEXT_TOKENS } from '../../providers/runtime-context.js';
import type { ModelCacheAccessor } from '../../providers/model/resolution.js';
import { selectRoutingProfile } from './routing-selection.js';

function cacheOnlyResolvableProfile(): ResolvedImplementerProfile {
  return {
    name: 'cache-worker',
    capabilities: { writesFiles: 'extracted-code' },
    isDefault: true,
    config: {
      kind: 'api',
      provider: 'ollama',
      service: 'ollama',
      offering: 'local',
      apiBase: 'http://localhost:11434/v1',
      model: 'runtime-only-model',
    },
  };
}

function detectedFallbackProfiles(): ResolvedImplementerProfile[] {
  return [
    {
      name: 'cheap-detected-worker',
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
        providerId === 'ollama'
          ? [
              {
                id: 'runtime-only-model',
                effectiveContextTokens: 64_000,
                pricingInput: 1,
                pricingOutput: 2,
              },
            ]
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
      resolvedProfiles: [profile],
      getRunnerModelName,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.routingDecision.selectedProfile).toBe('cache-worker');
    expect(result.routingDecision.contextLength).toBe(64_000);
    expect(result.selectedProfile).toEqual(profile);
  });

  it("estimates the brief with the run's plan context", async () => {
    const wctx = makeTaskWorkflowContext();
    const task = makeTask();
    const state = makeImplStateWithMetadata([task]);
    const select = (s: typeof state) =>
      selectRoutingProfile({
        wctx,
        state: s,
        setTrackedState: () => {},
        task,
        resolvedProfiles: detectedFallbackProfiles(),
        getRunnerModelName,
      });

    const withoutPlan = await select(state);
    const withPlan = await select({
      ...state,
      plan: {
        summary: 'Route every write through the registry.',
        decisions: ['Keep the registry as the one source of truth. '.repeat(400)],
        criteria: [],
        checks: [],
        validation: null,
      },
    });

    expect(withoutPlan.ok && withPlan.ok).toBe(true);
    if (!withoutPlan.ok || !withPlan.ok) return;
    expect(withPlan.routingDecision.estimatedTokens).toBeGreaterThan(
      withoutPlan.routingDecision.estimatedTokens + 1_000,
    );
  });

  it('falls an api profile back to the application budget when no model cache is provided', async () => {
    const wctx = makeTaskWorkflowContext();
    const task = makeTask();
    const state = makeImplStateWithMetadata([task]);
    const profile = cacheOnlyResolvableProfile();

    const result = await selectRoutingProfile({
      wctx,
      state,
      setTrackedState: () => {},
      task,
      resolvedProfiles: [profile],
      getRunnerModelName,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.routingDecision.contextLength).toBe(APPLICATION_DEFAULT_CONTEXT_TOKENS);
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
      resolvedProfiles: profiles,
      getRunnerModelName,
    });

    expect(withoutDetected.ok).toBe(true);
    if (!withoutDetected.ok) return;
    expect(withoutDetected.routingDecision.selectedProfile).toBe(profiles[0]!.name);
    expect(withoutDetected.routingDecision.contextLength).toBe(DEFAULT_UNKNOWN_CONTEXT_LENGTH);

    const withDetected = await selectRoutingProfile({
      wctx: makeTaskWorkflowContext({ detectedContextLength: 20_000 }),
      state,
      setTrackedState: () => {},
      task,
      resolvedProfiles: profiles,
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
      resolvedProfiles: profiles,
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
      resolvedProfiles: profiles,
      getRunnerModelName,
    });

    expect(normal.ok).toBe(true);
    if (!normal.ok) return;
    expect(normal.selectedProfile).toBe(profiles[0]);
    expect(normal.routingDecision.selectedProfile).toBe('cheap-detected-worker');
  });
});
