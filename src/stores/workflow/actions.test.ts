import { describe, it, expect, beforeEach } from 'vitest';
import { addEvent, markCancellationRequested, resetWorkflow, getSections } from './actions.js';
import { eventsStore, MAX_EVENTS } from './events.js';
import { tasksStore } from './tasks.js';
import { tokensStore } from './tokens.js';
import { lifecycleStore } from './lifecycle.js';
import { abortStore } from './abort.js';
import { activityStore } from './activity.js';
import { planEditorStore } from './plan-editor.js';
import { approvalPromptStore, openApprovalPrompt } from '../approval-prompt/prompt.js';
import { costApprovalStore, openCostApprovalPrompt } from '../cost-approval/prompt.js';
import { taskId } from '../../core/schemas/task.js';
import type { CostPrediction } from '../../core/schemas/summary.js';
import {
  makePlannerStatus,
  makeRetry,
  makeTaskStart,
  makeTaskComplete,
  makeCostUpdate,
} from '#testing/helpers/events.js';
import { makeTask } from '#testing/helpers/factories/task.js';

describe('addEvent — cross-bucket isolation', () => {
  beforeEach(() => resetWorkflow());

  it('preserves unrelated sub-store fields on generic events', () => {
    lifecycleStore.__testReset({ phase: 'implementing' });
    tokensStore.__testReset({ localCount: 3, escalatedCount: 1 });
    addEvent(makeRetry());
    expect(lifecycleStore.get().phase).toBe('implementing');
    expect(tokensStore.get().localCount).toBe(3);
    expect(tokensStore.get().escalatedCount).toBe(1);
  });
});

describe('markCancellationRequested', () => {
  beforeEach(() => resetWorkflow());

  it('sets local cancelled state without appending a fake workflow_cancelled event', () => {
    addEvent(makePlannerStatus({ phase: 'researching', status: 'running' }));
    markCancellationRequested({ ts: 2_000 });
    expect(lifecycleStore.get().cancelled).toBe(true);
    const events = eventsStore.get().events;
    expect(events).toHaveLength(1);
    const status = events.find((e) => e.type === 'planner_status');
    expect(status && 'status' in status ? status.status : undefined).toBe('running');
  });

  it('is a no-op on double cancel', () => {
    markCancellationRequested();
    const after1 = eventsStore.get().events.length;
    markCancellationRequested();
    expect(eventsStore.get().events.length).toBe(after1);
  });

  it('returns true on first call and false on subsequent calls', () => {
    expect(markCancellationRequested()).toBe(true);
    expect(markCancellationRequested()).toBe(false);
  });

  it('accepts the canonical workflow_cancelled event through the bounded event stream', () => {
    for (let i = 0; i < MAX_EVENTS; i += 1) {
      addEvent(makeRetry({ taskId: taskId(`T${String((i % 999) + 1).padStart(3, '0')}`) }));
    }

    markCancellationRequested();
    addEvent({ type: 'workflow_cancelled', ts: Date.now(), phase: 'implementing' });

    const events = eventsStore.get().events;
    expect(events).toHaveLength(MAX_EVENTS);
    expect((events[0] as { taskId: string }).taskId).toBe('T002');
    expect(events[events.length - 1]?.type).toBe('workflow_cancelled');
  });
});

describe('addEvent — cancelled gate', () => {
  beforeEach(() => resetWorkflow());

  it('drops error events after cancel', () => {
    markCancellationRequested();
    addEvent({ type: 'error', ts: Date.now(), phase: 'implementing', message: 'noise' });
    expect(eventsStore.get().events.filter((e) => e.type === 'error')).toHaveLength(0);
  });

  it('drops late runner activity after cancel so interrupted rows do not reappear', () => {
    markCancellationRequested();
    addEvent({
      type: 'runner_call_activity',
      ts: Date.now(),
      phase: 'implementing',
      callId: 'call-1',
      role: 'implementer',
      backendKind: 'cli',
      runnerName: 'codex',
      sequence: 1,
      activityId: 'call-1:terminal',
      stage: 'aborted',
      kind: 'error',
      label: 'aborted runner_interrupted',
      redacted: false,
    });

    expect(eventsStore.get().events.filter((e) => e.type === 'runner_call_activity')).toEqual([]);
    expect(activityStore.get().items).toEqual([]);
  });

  it('drops planner_status events after cancel', () => {
    markCancellationRequested();
    addEvent(makePlannerStatus({ phase: 'researching', status: 'running' }));
    expect(eventsStore.get().events.filter((e) => e.type === 'planner_status')).toHaveLength(0);
  });

  it('does not mutate tasks store after cancel', () => {
    markCancellationRequested();
    addEvent(makeTaskStart({ index: 0, total: 1 }));
    expect(tasksStore.get().currentTask).toBe(0);
    expect(tasksStore.get().totalTasks).toBe(0);
  });

  it('does not mutate tokens store after cancel', () => {
    markCancellationRequested();
    addEvent(makeTaskComplete({ method: 'local' }));
    expect(tokensStore.get().localCount).toBe(0);
  });
});

describe('resetWorkflow', () => {
  beforeEach(() => resetWorkflow());

  it('closes a pending tiered approval prompt with the cancelled decision', async () => {
    const pending = openApprovalPrompt({
      tier: 'sticky',
      actionClass: 'network',
      actionDescription: 'push to origin',
      phase: 'implementing',
    });
    expect(approvalPromptStore.get().status).toBe('pending');

    resetWorkflow();

    expect(approvalPromptStore.get().status).toBe('idle');
    await expect(pending).resolves.toEqual({ decision: 'deny', reason: 'user_cancelled' });
  });

  it('closes a pending cost-approval prompt as not approved', async () => {
    const prediction: CostPrediction = {
      estimatedTasks: 1,
      lowCost: 0.01,
      expectedCost: 0.02,
      highCost: 0.05,
      plannerTool: 'anthropic',
      implementerTool: 'anthropic',
    };
    const pending = openCostApprovalPrompt(prediction);
    expect(costApprovalStore.get().status).toBe('pending');

    resetWorkflow();

    expect(costApprovalStore.get().status).toBe('idle');
    await expect(pending).resolves.toBe(false);
  });

  it('clears armed abort state before resetting sub-stores', () => {
    // Seed the abort store into an armed state, then verify resetWorkflow clears it
    // — this is the observable contract the dispatcher must preserve.
    abortStore.arm('exit');
    expect(abortStore.get().armed).toBe('exit');
    resetWorkflow();
    expect(abortStore.get().armed).toBe('none');
  });

  it('resets workflow sub-stores to initial state', () => {
    addEvent(makeTaskStart({ index: 1, total: 3 }));
    addEvent(makePlannerStatus({ phase: 'implementing', status: 'running' }));
    addEvent({
      type: 'runner_call_tool_use',
      ts: Date.now(),
      phase: 'implementing',
      callId: 'call-1',
      role: 'implementer',
      backendKind: 'cli',
      sequence: 1,
      stage: 'delta',
      name: 'Bash',
      inputDelta: '{"command":"npm run typecheck"}',
    });
    addEvent(makeTaskComplete({ method: 'local' }));

    resetWorkflow();

    expect(eventsStore.get().events).toEqual([]);
    expect(tasksStore.get().currentTask).toBe(0);
    expect(tasksStore.get().totalTasks).toBe(0);
    expect(tokensStore.get().localCount).toBe(0);
    expect(lifecycleStore.get().phase).toBe('idle');
    expect(lifecycleStore.get().cancelled).toBe(false);
    expect(lifecycleStore.get().queueDepth).toBe(0);
    expect(activityStore.get().items).toEqual([]);
  });

  it('clears session-scoped plan editor state', () => {
    planEditorStore.setRuntimeRichMode(true);
    planEditorStore.setStatusMessage('updated title');
    planEditorStore.setSaveError('failed save');

    resetWorkflow();

    expect(planEditorStore.get()).toMatchObject({
      runtimeRichMode: false,
      saveError: null,
      statusMessage: null,
    });
  });

  it('restores observable workflow state from a persisted resume snapshot', () => {
    resetWorkflow({
      stateVersion: 1,
      phase: 'implementing',
      feature: 'f',
      currentTaskIndex: 2,
      attempt: 0,
      tasks: [
        makeTask({ id: 'T001', status: 'done' }),
        makeTask({ id: 'T002', status: 'done' }),
        makeTask({ id: 'T003', status: 'pending' }),
      ],
      plannerSessionId: null,
      startedAt: new Date().toISOString(),
      tokenUsage: {
        plannerInput: 0,
        plannerOutput: 0,
        implementerInput: 0,
        implementerOutput: 0,
        escalationInput: 0,
        escalationOutput: 0,
      },
      plannerTool: 'anthropic',
      plannerModel: 'claude-sonnet-4-6',
      implementerTool: 'deepseek',
      implementerModel: 'deepseek-chat',
      awaitingContinue: false,
      messageQueue: [
        {
          id: 'q1',
          text: 'queued',
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
    expect(tokensStore.get().tokenUsage).toEqual({
      plannerInput: 0,
      plannerOutput: 0,
      implementerInput: 0,
      implementerOutput: 0,
      escalationInput: 0,
      escalationOutput: 0,
    });
    expect(tokensStore.get().localCount).toBe(2);
    expect(tokensStore.get().escalatedCount).toBe(0);
    expect(tokensStore.get().completedTaskCount).toBe(2);
    expect(tokensStore.get().pricingContext).toEqual({
      plannerTool: 'anthropic',
      plannerModel: 'claude-sonnet-4-6',
      implementerTool: 'deepseek',
      implementerModel: 'deepseek-chat',
    });
  });

  it('reconstructs resumed task attempts with cache, context, and routing metadata', () => {
    resetWorkflow({
      stateVersion: 1,
      phase: 'implementing',
      feature: 'f',
      currentTaskIndex: 1,
      attempt: 0,
      tasks: [makeTask({ id: 'T001', status: 'done' })],
      plannerSessionId: null,
      startedAt: new Date().toISOString(),
      tokenUsage: {
        plannerInput: 0,
        plannerOutput: 0,
        implementerInput: 0,
        implementerOutput: 0,
        implementerCacheRead: 1_000_000,
        escalationInput: 0,
        escalationOutput: 0,
      },
      plannerTool: 'anthropic',
      plannerModel: 'claude-sonnet-4-6',
      implementerTool: 'openai',
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
          tool: 'openai',
          model: 'runtime-priced-model',
          implementerProfile: 'cheap-cloud',
          contextFit: 'tight',
          estimatedTokens: 95_000,
          untruncatedEstimatedTokens: 120_000,
          contextLength: 100_000,
          currentCodeTruncated: true,
          currentCodeContextMode: 'function-level',
          costPosture: 'price-known',
          routingReason: 'selected cheapest capable profile',
        },
      ],
    });

    const record = tokensStore.get().perTask['T001'];
    expect(record?.totalTokens).toBe(1_000_000);
    expect(record?.attempts?.[0]).toMatchObject({
      implementerCacheReadTokens: 1_000_000,
      implementerCacheCreateTokens: 0,
      tool: 'openai',
      model: 'runtime-priced-model',
      implementerProfile: 'cheap-cloud',
      contextFit: 'tight',
      estimatedTokens: 95_000,
      untruncatedEstimatedTokens: 120_000,
      contextLength: 100_000,
      currentCodeTruncated: true,
      currentCodeContextMode: 'function-level',
      costPosture: 'price-known',
      routingReason: 'selected cheapest capable profile',
    });
    expect(tokensStore.get().localCount).toBe(1);
    expect(tokensStore.get().escalatedCount).toBe(0);
  });

  it('classifies resumed escalated-intermediate methods as escalated even with legacy done status', () => {
    resetWorkflow({
      stateVersion: 1,
      phase: 'implementing',
      feature: 'f',
      currentTaskIndex: 1,
      attempt: 0,
      tasks: [makeTask({ id: 'T001', status: 'done' })],
      plannerSessionId: null,
      startedAt: new Date().toISOString(),
      tokenUsage: {
        plannerInput: 0,
        plannerOutput: 0,
        implementerInput: 100,
        implementerOutput: 50,
        escalationInput: 0,
        escalationOutput: 0,
      },
      awaitingContinue: false,
      messageQueue: [],
      taskBreakdowns: [
        {
          taskId: taskId('T001'),
          taskTitle: 'Intermediate task',
          method: 'escalated-intermediate',
          implementerTokens: 150,
          escalationTokens: 0,
          retryCount: 1,
        },
      ],
    });

    expect(tokensStore.get().localCount).toBe(0);
    expect(tokensStore.get().escalatedCount).toBe(1);
  });

  it('reconstructs pending queue depth and previews from undrained non-native messages on resume', () => {
    const queuedAt = new Date().toISOString();

    resetWorkflow({
      stateVersion: 1,
      phase: 'planning',
      feature: 'f',
      currentTaskIndex: 0,
      attempt: 0,
      tasks: [],
      plannerSessionId: null,
      startedAt: queuedAt,
      tokenUsage: {
        plannerInput: 0,
        plannerOutput: 0,
        implementerInput: 0,
        implementerOutput: 0,
        escalationInput: 0,
        escalationOutput: 0,
      },
      awaitingContinue: false,
      messageQueue: [
        {
          id: 'pending',
          text: 'token sk-proj-abcdefghijklmnopqrstuvwxyz',
          queuedAt,
          phase: 'planning',
          deliveredViaNative: false,
          nativeDeliveryState: 'pending',
        },
        {
          id: 'native',
          text: 'already delivered',
          queuedAt,
          phase: 'planning',
          deliveredViaNative: true,
          nativeDeliveryState: 'delivered',
        },
        {
          id: 'drained',
          text: 'already drained',
          queuedAt,
          phase: 'planning',
          deliveredViaNative: false,
          nativeDeliveryState: 'pending',
          drainedAt: queuedAt,
        },
        {
          id: 'clarification',
          text: 'Use GraphQL',
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
    expect(lifecycleStore.get().queuePreviews).toEqual([
      { id: 'pending', preview: 'token sk-***REDACTED***' },
      { id: 'clarification', preview: 'clarification: Which API style? -> Use GraphQL' },
    ]);
  });

  it('uses resumed token usage as the baseline for the next cumulative cost update', () => {
    resetWorkflow({
      stateVersion: 1,
      phase: 'planning',
      feature: 'f',
      currentTaskIndex: 0,
      attempt: 0,
      tasks: [makeTask({ id: 'T001', status: 'pending' })],
      plannerSessionId: null,
      startedAt: new Date().toISOString(),
      tokenUsage: {
        plannerInput: 100,
        plannerOutput: 50,
        implementerInput: 0,
        implementerOutput: 0,
        escalationInput: 0,
        escalationOutput: 0,
      },
      awaitingContinue: false,
      messageQueue: [],
    });

    addEvent(
      makeCostUpdate({
        phase: 'planning',
        tokenUsage: {
          plannerInput: 150,
          plannerOutput: 75,
          implementerInput: 0,
          implementerOutput: 0,
          escalationInput: 0,
          escalationOutput: 0,
        },
      }),
    );

    expect(tokensStore.get().perPhase['planning']).toMatchObject({
      inputTokens: 50,
      outputTokens: 25,
    });
  });
});

describe('getSections', () => {
  beforeEach(() => resetWorkflow());

  it('reflects the current event stream', () => {
    addEvent(makeRetry());
    expect(getSections()).toHaveLength(1);
  });

  it('clears derived sections after workflow reset', () => {
    addEvent(makeRetry());
    expect(getSections()).toHaveLength(1);
    resetWorkflow();
    expect(getSections()).toEqual([]);
  });
});
