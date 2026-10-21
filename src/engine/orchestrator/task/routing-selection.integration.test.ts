import { afterEach, describe, expect, it } from 'vitest';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplStateWithMetadata } from '#testing/helpers/factories/workflow-state.js';
import {
  cleanupTaskProjects,
  makeTaskWorkflowContext,
} from '#testing/helpers/orchestrator-task-context.js';
import type { ResolvedImplementerProfile } from '../../../core/config/accessors/implementer-profiles.js';
import { getRunnerModelName } from '../../../core/config/accessors/runner-config.js';
import { loadState, saveState } from '../../../core/state/persistence.js';
import { transition } from '../../../core/state/machine.js';
import { taskId } from '../../../core/schemas/task.js';
import { DEFAULT_UNKNOWN_CONTEXT_LENGTH } from '../../../core/tokens/context-length.js';
import { APPLICATION_DEFAULT_CONTEXT_TOKENS } from '../../providers/runtime-context.js';
import type { ModelCacheAccessor } from '../../providers/model/resolution.js';
import { applyRecoveryAction } from '../recovery/actions.js';
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
        decisions: [
          { text: 'Keep the registry as the one source of truth. '.repeat(400), taskId: null },
        ],
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

describe('selectRoutingProfile recovery pin', () => {
  it('routes the pinned brief to its profile after the state is reopened, and no other brief', async () => {
    const task = makeTask({ id: 'T010' });
    const otherTask = makeTask({ id: 'T011' });
    const profiles = detectedFallbackProfiles();
    const wctx = makeTaskWorkflowContext();
    const ref = { projectDir: wctx.projectDir, sessionId: wctx.sessionId };
    saveState(ref, {
      ...makeImplStateWithMetadata([task, otherTask]),
      retryProfile: { taskId: task.id, profile: 'standard-worker' },
    });
    const state = loadState(ref);
    expect(state?.retryProfile).toEqual({ taskId: task.id, profile: 'standard-worker' });
    if (state === null) return;

    const selected = await selectRoutingProfile({
      wctx,
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

    const normal = await selectRoutingProfile({
      wctx,
      state: { ...state, currentTaskIndex: 1 },
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

  it('keeps the pin after the brief starts, so a stop and a reopen route it to its profile again', async () => {
    const task = makeTask({ id: 'T001' });
    const profiles = detectedFallbackProfiles();
    const wctx = makeTaskWorkflowContext();
    const ref = { projectDir: wctx.projectDir, sessionId: wctx.sessionId };
    const pinned = {
      ...makeImplStateWithMetadata([task]),
      retryProfile: { taskId: task.id, profile: 'standard-worker' },
    };
    saveState(ref, transition(pinned, { type: 'START_TASK', taskId: taskId('T001') }));
    const state = loadState(ref);
    if (state === null) throw new Error('state not saved');

    const selected = await selectRoutingProfile({
      wctx,
      state,
      setTrackedState: () => {},
      task,
      resolvedProfiles: profiles,
      getRunnerModelName,
    });

    expect(selected.ok && selected.selectedProfile.name).toBe('standard-worker');
  });

  it('names the pinned profile when it does not fit, so Try again runs the seat saved to it', async () => {
    const task = makeTask({ id: 'T001', description: 'large routing input '.repeat(2000) });
    const smallSeat = (contextLength: number): ResolvedImplementerProfile => ({
      name: 'small',
      capabilities: { writesFiles: 'extracted-code' },
      isDefault: false,
      config: { kind: 'agent', command: 'small-worker', model: 'small-model', contextLength },
    });
    const big: ResolvedImplementerProfile = {
      name: 'big',
      capabilities: { writesFiles: 'extracted-code' },
      isDefault: true,
      config: {
        kind: 'agent',
        command: 'big-worker',
        model: 'big-model',
        contextLength: 1_000_000,
      },
    };
    const wctx = makeTaskWorkflowContext();
    const ref = { projectDir: wctx.projectDir, sessionId: wctx.sessionId };
    saveState(ref, {
      ...makeImplStateWithMetadata([task]),
      retryProfile: { taskId: task.id, profile: 'small' },
    });
    const pinned = loadState(ref);
    if (pinned === null) throw new Error('state not saved');

    const halted = await selectRoutingProfile({
      wctx,
      state: pinned,
      setTrackedState: () => {},
      task,
      resolvedProfiles: [big, smallSeat(1_000)],
      getRunnerModelName,
    });
    expect(halted.ok).toBe(false);
    expect(halted.state.pendingRecovery?.reason).toBe('context-overflow');
    expect(halted.state.pendingRecovery?.selectedImplementerProfile).toBe('small');

    const tried = await applyRecoveryAction({
      ...ref,
      state: halted.state,
      action: 'retry-same-worker',
      bus: wctx.bus,
    });
    if (!tried.ok) throw new Error('Try again was refused');
    expect(tried.state.retryProfile).toEqual({ taskId: task.id, profile: 'small' });

    const routed = await selectRoutingProfile({
      wctx,
      state: tried.state,
      setTrackedState: () => {},
      task,
      resolvedProfiles: [big, smallSeat(1_000_000)],
      getRunnerModelName,
    });
    expect(routed.ok && routed.selectedProfile.name).toBe('small');
  });
});
