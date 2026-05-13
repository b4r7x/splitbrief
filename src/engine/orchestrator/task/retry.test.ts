import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeImplStateWithMetadata as implementingState } from '#testing/helpers/factories/workflow-state.js';
import {
  makeCallbacks,
  makeBusRecorder,
  makeImplementer,
  makePlanner,
} from '#testing/helpers/orchestrator-factories.js';
import {
  cleanupTaskProjects,
  makeTaskWorkflowContext as makeWorkflowContext,
  setupTaskProject as setupProject,
} from '#testing/helpers/orchestrator-task-context.js';
import type { TaskTokenUsage } from '../../../core/schemas/tokens.js';
import { loadState } from '../../../core/state/persistence.js';
import { transition } from '../../../core/state/machine.js';
import { retryAndRecord } from './retry.js';

afterEach(cleanupTaskProjects);

describe('retryAndRecord — retry budget', () => {
  it('local retry on first attempt succeeds → advances task, records local method', async () => {
    const task = makeTask({ id: 'T001' });
    const state = implementingState([task]);

    const { callbacks } = makeCallbacks();
    const { bus, events: busEvents } = makeBusRecorder();
    const retry = vi.fn().mockResolvedValue({
      success: true,
      output: 'fixed',
      usage: { inputTokens: 50, outputTokens: 25 },
    });
    const implementer = makeImplementer({ retry });

    const wctx = makeWorkflowContext({ callbacks, implementer, bus });
    const setTrackedState = vi.fn();
    const taskBreakdowns: TaskTokenUsage[] = [];

    const res = await retryAndRecord({
      wctx,
      task,
      initialError: 'tsc failed',
      state,
      taskStartTime: Date.now(),
      tokensBefore: { ...state.tokenUsage },
      taskBreakdowns,
      setTrackedState,
    });

    expect(res.completed).toBe(true);
    expect(res.state.tasks[0]?.status).toBe('done');
    expect(res.state.currentTaskIndex).toBe(1);

    const retryEvents = busEvents.filter((e) => e.type === 'task_retry');
    expect(retryEvents.length).toBeGreaterThanOrEqual(1);
    const firstRetry = retryEvents[0];
    if (firstRetry?.type === 'task_retry') {
      expect(firstRetry.taskId).toBe('T001');
      expect(firstRetry.attempt).toBe(1);
    }

    expect(taskBreakdowns[0]?.method).toBe('local');
  });

  it('exhausts local retry budget and persists recovery when escalation also fails', async () => {
    const task = makeTask({ id: 'T001' });
    let state = implementingState([task]);
    state = transition(state, { type: 'START_TASK', taskId: task.id });
    state = transition(state, { type: 'TASK_SENT' });

    const { callbacks } = makeCallbacks();
    const { bus, events: busEvents } = makeBusRecorder();
    const retry = vi.fn().mockResolvedValue({
      success: false,
      output: 'still broken',
      error: 'tsc failed again',
      usage: { inputTokens: 20, outputTokens: 10 },
    });
    const planner = makePlanner({
      escalateHint: vi.fn().mockResolvedValue({ success: false, output: '', code: null, usage: null }),
      escalateFull: vi.fn().mockResolvedValue({ success: false, output: '', code: null, usage: null }),
    });
    const implementer = makeImplementer({ retry });

    const wctx = makeWorkflowContext({
      callbacks,
      implementer,
      planner,
      bus,
      config: makeConfig({
        validation: { typecheck: false, lint: false, test: false, testCommand: 'noop' },
        workflow: { commitStrategy: 'none', maxRetries: 2 },
      }),
    });

    const res = await retryAndRecord({
      wctx,
      task,
      initialError: 'initial tsc failure',
      state,
      taskStartTime: Date.now(),
      tokensBefore: { ...state.tokenUsage },
      taskBreakdowns: [],
      setTrackedState: vi.fn(),
    });

    expect(res.completed).toBe(false);
    expect(res.state.tasks[0]?.status).toBe('in_progress');
    expect(res.state.currentTaskIndex).toBe(0);
    expect(res.state.pendingRecovery).toMatchObject({
      reason: 'retry-exhausted',
      taskId: 'T001',
      availableActions: ['retry-same-worker', 'planner-split-rebase', 'skip-current-task', 'pause-run', 'abort-workflow'],
    });
    expect(loadState(wctx.projectDir, wctx.sessionId)?.pendingRecovery).toMatchObject({
      reason: 'retry-exhausted',
      taskId: 'T001',
    });

    const complete = busEvents.find((e) => e.type === 'task_completed');
    expect(complete).toBeUndefined();
    expect(busEvents.find((e) => e.type === 'task_failed')).toBeUndefined();

    const retryEvents = busEvents.filter((e) => e.type === 'task_retry');
    expect(retryEvents.length).toBeGreaterThanOrEqual(2);
  });
});

describe('retryAndRecord — recovery stop points', () => {
  it('persists pending recovery when retry or escalation throws before returning a result', async () => {
    const { projectDir, sessionId } = setupProject();

    const task = makeTask({ id: 'T001' });
    let state = implementingState([task]);
    state = transition(state, { type: 'START_TASK', taskId: task.id });
    state = transition(state, { type: 'TASK_SENT' });

    const { bus, events } = makeBusRecorder();
    const planner = makePlanner({
      escalateHint: vi.fn().mockRejectedValueOnce(new Error('planner crashed')),
    });
    const implementer = makeImplementer({ retry: vi.fn() });
    const wctx = makeWorkflowContext({
      projectDir,
      sessionId,
      bus,
      planner,
      implementer,
      config: makeConfig({
        validation: { typecheck: false, lint: false, test: false, testCommand: 'noop' },
        workflow: { commitStrategy: 'none', maxRetries: 0 },
      }),
    });

    const result = await retryAndRecord({
      wctx,
      task,
      initialError: 'initial validation failed',
      state,
      taskStartTime: Date.now(),
      taskStartSnapshot: { head: 'HEAD', files: [], dirtyFileContents: {} },
      tokensBefore: { ...state.tokenUsage },
      taskBreakdowns: [],
      setTrackedState: vi.fn(),
    });

    expect(result.completed).toBe(false);
    expect(result.state.pendingRecovery).toMatchObject({
      reason: 'retry-exhausted',
      taskId: 'T001',
      availableActions: ['retry-same-worker', 'planner-split-rebase', 'skip-current-task', 'pause-run', 'abort-workflow'],
    });
    expect(loadState(projectDir, sessionId)?.pendingRecovery).toMatchObject({
      reason: 'retry-exhausted',
      taskId: 'T001',
    });
    expect(events).toContainEqual(expect.objectContaining({
      type: 'recovery_prompted',
      reason: 'retry-exhausted',
      taskId: 'T001',
      availableActions: ['retry-same-worker', 'planner-split-rebase', 'skip-current-task', 'pause-run', 'abort-workflow'],
    }));
  });

  it('adds recovery to the latest persisted retry state when a later retry step throws', async () => {
    const { projectDir, sessionId } = setupProject();

    const task = makeTask({ id: 'T001' });
    let state = implementingState([task]);
    state = transition(state, { type: 'START_TASK', taskId: task.id });
    state = transition(state, { type: 'TASK_SENT' });

    const { bus, events } = makeBusRecorder();
    const implementer = makeImplementer({
      retry: vi.fn().mockResolvedValue({
        success: false,
        error: 'retry still failed',
        usage: { inputTokens: 10, outputTokens: 5 },
      }),
    });
    const planner = makePlanner({
      escalateHint: vi.fn().mockRejectedValueOnce(new Error('hint planner crashed')),
    });
    const wctx = makeWorkflowContext({
      bus,
      implementer,
      planner,
      projectDir,
      sessionId,
      config: makeConfig({
        validation: { typecheck: false, lint: false, test: false, testCommand: 'noop' },
        workflow: { commitStrategy: 'none', maxRetries: 1 },
      }),
    });

    const result = await retryAndRecord({
      wctx,
      task,
      initialError: 'initial validation failed',
      state,
      taskStartTime: Date.now(),
      taskStartSnapshot: { head: 'HEAD', files: [], dirtyFileContents: {} },
      tokensBefore: { ...state.tokenUsage },
      taskBreakdowns: [],
      setTrackedState: vi.fn(),
    });

    expect(result.completed).toBe(false);
    expect(result.state.attempt).toBe(1);
    expect(result.state.pendingRecovery).toMatchObject({
      reason: 'retry-exhausted',
      taskId: 'T001',
      attempts: 1,
    });
    expect(loadState(projectDir, sessionId)).toMatchObject({
      attempt: 1,
      pendingRecovery: expect.objectContaining({ reason: 'retry-exhausted' }),
    });
    expect(events).toContainEqual(expect.objectContaining({
      type: 'recovery_prompted',
      reason: 'retry-exhausted',
      taskId: 'T001',
    }));
  });
});
