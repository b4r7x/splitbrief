import { describe, it, expect, beforeEach } from 'vitest';
import { addEvent } from './event.js';
import { hydrateFromState } from './hydrate.js';
import { loadEvents } from './load.js';
import { resetWorkflow } from './reset.js';
import { tasksStore } from '../tasks.js';
import { tokensStore } from '../tokens.js';
import { lifecycleStore } from '../lifecycle.js';
import { configStore } from '../../project/config.js';
import { taskId } from '../../../core/schemas/task.js';
import { makeCostUpdate, makeTaskStart, makeRetry } from '#testing/helpers/events/task.js';
import { makeWorkflowState } from '#testing/helpers/factories/workflow-state.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeUsage } from '#testing/helpers/factories/summary.js';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { plainUserMessage } from '../../../core/types/user-input.js';
import { makeMessage } from '#testing/helpers/queue.js';

describe('hydrateFromState', () => {
  beforeEach(() => resetWorkflow());

  it('keeps the first-delivery count through replay, hydrate and a later BUILD delivery', () => {
    const reviewed = {
      ...makeMessage('review history'),
      id: 'reviewed',
      deliveredTo: { reviewer: new Date().toISOString() },
    };
    const pending = { ...makeMessage('pending'), id: 'pending' };
    loadEvents([
      { type: 'message_queued', ts: 1, phase: 'final-review', id: reviewed.id },
      {
        type: 'queue_drained',
        ts: 2,
        phase: 'final-review',
        ids: [reviewed.id],
        count: 1,
        seat: 'review',
      },
      { type: 'message_queued', ts: 3, phase: 'implementing', id: pending.id },
      {
        type: 'queue_drained',
        ts: 4,
        phase: 'implementing',
        ids: [reviewed.id],
        count: 1,
        seat: 'build',
      },
    ]);
    expect(lifecycleStore.get().queueDepth).toBe(1);
    hydrateFromState(
      makeWorkflowState({ phase: 'implementing', messageQueue: [reviewed, pending] }),
    );
    expect(lifecycleStore.get().queueDepth).toBe(1);
    addEvent({
      type: 'queue_drained',
      ts: 5,
      phase: 'implementing',
      ids: [reviewed.id],
      count: 1,
      seat: 'build',
    });
    expect(lifecycleStore.get().queueDepth).toBe(1);
    addEvent({ type: 'queue_cleared', ts: 6, phase: 'implementing', count: 1 });
    expect(lifecycleStore.get().queueDepth).toBe(0);
  });

  it('counts a native injection until it is acknowledged after hydration', () => {
    const injecting = { ...makeMessage(), nativeDeliveryState: 'injecting' as const };
    hydrateFromState(makeWorkflowState({ messageQueue: [injecting] }));
    expect(lifecycleStore.get().queueDepth).toBe(1);
    addEvent({ type: 'message_injected_native', ts: 1, phase: 'planning', id: injecting.id });
    expect(lifecycleStore.get().queueDepth).toBe(0);
  });

  it.each(['implementing', 'complete'] as const)(
    'clears a replayed live call on %s hydration',
    (phase) => {
      loadEvents([
        { type: 'steerable_call', ts: 1, phase: 'implementing', seat: 'build', taskId: 'T003' },
      ]);
      expect(lifecycleStore.get().steerableCall).toEqual({ seat: 'build', taskId: 'T003' });
      hydrateFromState(makeWorkflowState({ phase }));
      expect(lifecycleStore.get().steerableCall).toBeNull();
    },
  );

  it('keeps replayed lineage attempts and allowance after state hydration', () => {
    loadEvents([
      makeTaskStart({ lineageAttempt: 6, attemptAllowance: 12 }),
      makeRetry({ attempt: 1, lineageAttempt: 7, attemptAllowance: 12 }),
    ]);
    hydrateFromState(makeWorkflowState({ phase: 'implementing', tasks: [makeTask()] }));
    expect(tasksStore.get()).toMatchObject({ currentAttempt: 7, attemptAllowance: 12 });
  });

  it('restores observable workflow state from a persisted snapshot', () => {
    hydrateFromState({
      stateVersion: 1,
      phase: 'implementing',
      feature: 'f',
      currentTaskIndex: 2,
      attempt: 0,
      tasks: [
        makeTask({ id: 'T001', status: 'done' }),
        makeTask({
          id: 'T002',
          status: 'done',
          suggestedFiles: ['src/resumed.ts'],
          action: 'modify',
        }),
        makeTask({ id: 'T003', status: 'pending' }),
      ],
      plannerSessionId: null,
      startedAt: new Date().toISOString(),
      tokenUsage: makeUsage(),
      plannerTool: 'claude-code',
      plannerModel: 'claude-sonnet-4-6',
      implementerTool: 'ollama',
      implementerModel: 'qwen2.5-coder:7b',
      awaitingContinue: false,
      messageQueue: [
        {
          id: 'q1',
          ...plainUserMessage('queued'),
          queuedAt: new Date().toISOString(),
          phase: 'implementing',
          deliveredViaNative: false,
          nativeDeliveryState: 'pending',
        },
      ],
    });
    expect(lifecycleStore.get().phase).toBe('implementing');
    expect(lifecycleStore.get().queueDepth).toBe(1);
    expect(tasksStore.get().currentTask).toBe(3);
    expect(tasksStore.get().totalTasks).toBe(3);
    expect(tasksStore.get().tasks.map((task) => [task.id, task.status])).toEqual([
      ['T001', 'done'],
      ['T002', 'done'],
      ['T003', 'pending'],
    ]);
    expect(tasksStore.get().taskMap.get('T002')?.status).toBe('done');
    expect(tasksStore.get().taskMap.get('T002')?.file).toBe('src/resumed.ts');
    expect(tasksStore.get().taskMap.get('T002')?.action).toBe('modify');
    expect(tasksStore.get().taskMap.get('T002')?.route).toBeUndefined();
    expect(tokensStore.get().tokenUsage).toEqual(makeUsage());
    expect(tokensStore.get().completedTaskCount).toBe(2);
    expect(tokensStore.get().passSeats).toEqual({
      plannerTool: 'claude-code',
      plannerModel: 'claude-sonnet-4-6',
      implementerTool: 'ollama',
      implementerModel: 'qwen2.5-coder:7b',
    });
  });

  it('never claims a run read back from disk is still running', () => {
    hydrateFromState({
      stateVersion: 1,
      phase: 'implementing',
      feature: 'f',
      currentTaskIndex: 0,
      attempt: 0,
      tasks: [makeTask({ id: 'T001', status: 'pending' })],
      plannerSessionId: null,
      startedAt: new Date(1_000_000).toISOString(),
      tokenUsage: makeUsage(),
      awaitingContinue: false,
      messageQueue: [],
    });

    expect(lifecycleStore.get().status).toBe('paused');
  });

  it('reads a finished run back as complete at the moment it completed', () => {
    hydrateFromState({
      stateVersion: 1,
      phase: 'complete',
      feature: 'f',
      currentTaskIndex: 0,
      attempt: 0,
      tasks: [makeTask({ id: 'T001', status: 'done' })],
      plannerSessionId: null,
      startedAt: new Date(1_000_000).toISOString(),
      completedAt: new Date(1_120_000).toISOString(),
      tokenUsage: makeUsage(),
      awaitingContinue: false,
      messageQueue: [],
    });

    expect(lifecycleStore.get().status).toBe('complete');
    expect(lifecycleStore.get().phase).toBe('complete');
    expect(lifecycleStore.get().endedAt).toBe(1_120_000);
  });

  it('keeps the phase timestamps the replayed log recorded', () => {
    addEvent({ type: 'workflow_started', ts: 5_000, phase: 'planning', feature: 'f' });

    hydrateFromState({
      stateVersion: 1,
      phase: 'implementing',
      feature: 'f',
      currentTaskIndex: 0,
      attempt: 0,
      tasks: [],
      plannerSessionId: null,
      startedAt: new Date(5_000).toISOString(),
      tokenUsage: makeUsage(),
      awaitingContinue: false,
      messageQueue: [],
    });

    expect(lifecycleStore.get().phaseFirstSeenTs.planning).toBe(5_000);
  });

  it('prices resumed reviewer tokens with the identity the run started on', () => {
    configStore.__testReset({
      projectDir: '/tmp/hydrate-reviewer-pricing-test',
      config: makeConfig({
        reviewer: {
          kind: 'api',
          provider: 'custom-endpoint',
          model: 'swapped-after-the-run',
          apiBase: 'https://api.example.test/v1',
          apiKey: 'test-key',
        },
      }),
    });

    hydrateFromState({
      stateVersion: 1,
      phase: 'implementing',
      feature: 'f',
      currentTaskIndex: 0,
      attempt: 0,
      tasks: [makeTask({ id: 'T001', status: 'done' })],
      plannerSessionId: null,
      startedAt: new Date().toISOString(),
      tokenUsage: makeUsage({ reviewerInput: 20_000, reviewerOutput: 5_000 }),
      plannerTool: 'claude-code',
      plannerModel: 'claude-sonnet-4-6',
      implementerTool: 'ollama',
      reviewerTool: 'custom-endpoint',
      reviewerModel: 'custom-v4-flash',
      awaitingContinue: false,
      messageQueue: [],
    });

    expect(tokensStore.get().passSeats).toMatchObject({
      reviewerTool: 'custom-endpoint',
      reviewerModel: 'custom-v4-flash',
    });
  });

  it('leaves the reviewer out of the pricing context when the run pinned none', () => {
    configStore.__testReset({
      projectDir: '/tmp/hydrate-reviewer-pricing-test',
      config: makeConfig({
        reviewer: {
          kind: 'api',
          provider: 'custom-endpoint',
          model: 'custom-v4-flash',
          apiBase: 'https://api.example.test/v1',
          apiKey: 'test-key',
        },
      }),
    });

    hydrateFromState({
      stateVersion: 1,
      phase: 'implementing',
      feature: 'f',
      currentTaskIndex: 0,
      attempt: 0,
      tasks: [makeTask({ id: 'T001', status: 'done' })],
      plannerSessionId: null,
      startedAt: new Date().toISOString(),
      tokenUsage: makeUsage(),
      plannerTool: 'claude-code',
      plannerModel: 'claude-sonnet-4-6',
      implementerTool: 'ollama',
      awaitingContinue: false,
      messageQueue: [],
    });

    expect(tokensStore.get().passSeats).toEqual({
      plannerTool: 'claude-code',
      plannerModel: 'claude-sonnet-4-6',
      implementerTool: 'ollama',
      implementerModel: undefined,
    });
  });

  it('reconstructs task attempts with cache, context, and routing metadata', () => {
    hydrateFromState({
      stateVersion: 1,
      phase: 'implementing',
      feature: 'f',
      currentTaskIndex: 1,
      attempt: 0,
      tasks: [makeTask({ id: 'T001', status: 'done' })],
      plannerSessionId: null,
      startedAt: new Date().toISOString(),
      tokenUsage: makeUsage({ implementerCacheRead: 1_000_000 }),
      plannerTool: 'claude-code',
      plannerModel: 'claude-sonnet-4-6',
      implementerTool: 'custom-endpoint',
      implementerModel: 'runtime-priced-model',
      awaitingContinue: false,
      messageQueue: [],
      taskBreakdowns: [
        {
          taskId: taskId('T001'),
          taskTitle: 'Use cached context',
          method: 'local',
          implementerTokens: 0,
          escalationTokens: 0,
          implementerCacheReadTokens: 1_000_000,
          implementerCacheCreateTokens: 0,
          retryCount: 0,
          tool: 'custom-endpoint',
          model: 'runtime-priced-model',
          implementerProfile: 'cheap-cloud',
          contextFit: 'tight',
          estimatedTokens: 95_000,
          untruncatedEstimatedTokens: 120_000,
          contextLength: 100_000,
          currentCodeTruncated: true,
          currentCodeContextMode: 'function-level',
          routingReason: 'selected cheapest capable profile',
        },
      ],
    });

    const record = tokensStore.get().perTask['T001'];
    expect(record?.totalTokens).toBe(1_000_000);
    expect(record?.attempts?.[0]).toMatchObject({
      implementerCacheReadTokens: 1_000_000,
      implementerCacheCreateTokens: 0,
      tool: 'custom-endpoint',
      model: 'runtime-priced-model',
      implementerProfile: 'cheap-cloud',
      contextFit: 'tight',
      estimatedTokens: 95_000,
      untruncatedEstimatedTokens: 120_000,
      contextLength: 100_000,
      currentCodeTruncated: true,
      currentCodeContextMode: 'function-level',
      routingReason: 'selected cheapest capable profile',
    });
  });

  it('counts pending queue depth from undrained non-native messages', () => {
    const queuedAt = new Date().toISOString();

    hydrateFromState({
      stateVersion: 1,
      phase: 'planning',
      feature: 'f',
      currentTaskIndex: 0,
      attempt: 0,
      tasks: [],
      plannerSessionId: null,
      startedAt: queuedAt,
      tokenUsage: makeUsage(),
      awaitingContinue: false,
      messageQueue: [
        {
          id: 'pending',
          ...plainUserMessage('token sk-proj-abcdefghijklmnopqrstuvwxyz'),
          queuedAt,
          phase: 'planning',
          deliveredViaNative: false,
          nativeDeliveryState: 'pending',
        },
        {
          id: 'native',
          ...plainUserMessage('already delivered'),
          queuedAt,
          phase: 'planning',
          deliveredViaNative: true,
          nativeDeliveryState: 'delivered',
        },
        {
          id: 'drained',
          ...plainUserMessage('already drained'),
          queuedAt,
          phase: 'planning',
          deliveredViaNative: false,
          nativeDeliveryState: 'pending',
          drainedAt: queuedAt,
        },
        {
          id: 'clarification',
          ...plainUserMessage('Use GraphQL'),
          queuedAt,
          phase: 'specifying',
          deliveredViaNative: false,
          nativeDeliveryState: 'pending',
          origin: 'clarification',
          question: 'Which API style?',
        },
      ],
    });

    expect(lifecycleStore.get().queueDepth).toBe(2);
  });

  it('uses the hydrated token usage as the baseline for the next cumulative cost update', () => {
    hydrateFromState({
      stateVersion: 1,
      phase: 'planning',
      feature: 'f',
      currentTaskIndex: 0,
      attempt: 0,
      tasks: [makeTask({ id: 'T001', status: 'pending' })],
      plannerSessionId: null,
      startedAt: new Date().toISOString(),
      tokenUsage: makeUsage({ plannerInput: 100, plannerOutput: 50 }),
      awaitingContinue: false,
      messageQueue: [],
    });

    addEvent(
      makeCostUpdate({
        phase: 'planning',
        tokenUsage: makeUsage({ plannerInput: 150, plannerOutput: 75 }),
      }),
    );

    expect(tokensStore.get().perPhase['planning']).toMatchObject({
      inputTokens: 50,
      outputTokens: 25,
    });
  });
});
