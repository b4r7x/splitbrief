import { describe, it, expect, beforeEach } from 'vitest';
import { addEvent } from './event.js';
import { resetWorkflow } from './reset.js';
import { eventsStore } from '../events.js';
import { tasksStore } from '../tasks.js';
import { tokensStore } from '../tokens.js';
import { lifecycleStore } from '../lifecycle.js';
import { abortStore } from '../abort.js';
import { approvalPromptStore, openApprovalPrompt } from '../../approval-prompt/prompt.js';
import { costApprovalStore, openCostApprovalPrompt } from '../../cost-approval/prompt.js';
import { taskId } from '../../../core/schemas/task.js';
import type { CostPrediction } from '../../../core/schemas/summary.js';
import { makePlannerStatus } from '#testing/helpers/events/planner.js';
import { makeTaskStart, makeTaskComplete, makeCostUpdate } from '#testing/helpers/events/task.js';
import { makeTask } from '#testing/helpers/factories/task.js';

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
        makeTask({ id: 'T002', status: 'done', file: 'src/resumed.ts', action: 'modify' }),
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
    expect(tasksStore.get().taskMap.get('T002')?.file).toBe('src/resumed.ts');
    expect(tasksStore.get().taskMap.get('T002')?.action).toBe('modify');
    expect(tasksStore.get().taskMap.get('T002')?.route).toBeUndefined();
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

  it('reconstructs pending queue depth from undrained non-native messages on resume', () => {
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
