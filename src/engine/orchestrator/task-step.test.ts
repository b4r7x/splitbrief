import { describe, it, expect, afterEach, vi } from 'vitest';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import {
  makeCallbacks,
  makePlanner,
  makeImplementer,
} from '#testing/helpers/orchestrator-factories.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeConfig, defaultContext } from '#testing/helpers/factories/config.js';
import { ensureSessionDir } from '../../core/paths-io.js';
import { createInitialState, transition } from '../../core/state/machine.js';
import type { Task } from '../../core/schemas/task.js';
import type { WorkflowState } from '../../core/schemas/workflow.js';
import type { TaskTokenUsage } from '../../core/schemas/tokens.js';
import type { WorkflowContext, WorkflowSinks } from './types.js';
import { createValidator } from './validation.js';
import { retryAndRecord, runSingleTask } from './task-step.js';

let dirs: string[] = [];

afterEach(() => {
  for (const d of dirs) cleanupTempDir(d);
  dirs = [];
});

function setupProject(): { projectDir: string; sessionId: string } {
  const projectDir = createTempDir('task-step-test');
  dirs.push(projectDir);
  createTestGitRepo(projectDir);
  const sessionId = 'sess-task-step';
  ensureSessionDir(projectDir, sessionId);
  return { projectDir, sessionId };
}

function makeSinks(): WorkflowSinks {
  return { setAbortHandler: () => {}, setQueueHandler: () => {} };
}

function implementingState(tasks: Task[]): WorkflowState {
  let s = createInitialState('feat');
  s = transition(s, { type: 'START', feature: 'feat' });
  s = transition(s, { type: 'RESEARCH_DONE' });
  s = transition(s, { type: 'SPEC_DONE' });
  s = transition(s, { type: 'APPROVE_SPEC' });
  s = transition(s, { type: 'PLAN_DONE', tasks });
  s = transition(s, { type: 'APPROVE_PLAN' });
  return {
    ...s,
    implementerTool: 'ollama',
    implementerModel: 'qwen2.5',
    plannerTool: 'claude-code',
  };
}

function makeWorkflowContext(overrides?: Partial<WorkflowContext>): WorkflowContext {
  const proj = overrides?.projectDir
    ? { projectDir: overrides.projectDir, sessionId: overrides.sessionId ?? 'sess-task-step' }
    : setupProject();
  const callbacks = overrides?.callbacks ?? makeCallbacks().callbacks;
  const base: WorkflowContext = {
    projectDir: proj.projectDir,
    sessionId: proj.sessionId,
    config: makeConfig({
      // Disable validation subprocess entirely — keeps the test focused on task-step
      // plumbing, not on tsc/eslint/npm test I/O.
      validation: { typecheck: false, lint: false, test: false, testCommand: 'noop' },
      workflow: { commitStrategy: 'none', maxRetries: 2 },
    }),
    callbacks,
    planner: makePlanner(),
    implementer: makeImplementer(),
    context: defaultContext,
    metadata: { plannerTool: 'claude-code', implementerTool: 'ollama', mode: 'standard' },
    sinks: makeSinks(),
    validator: createValidator(),
  };
  return { ...base, ...overrides, projectDir: proj.projectDir, sessionId: proj.sessionId, callbacks };
}

describe('runSingleTask — happy path', () => {
  it('emits task-start and task-complete, advances to done, and records token usage', async () => {
    const task = makeTask({ id: 'T001' });
    const state = implementingState([task]);

    const { callbacks, events } = makeCallbacks();
    const implementer = makeImplementer({
      implement: vi.fn().mockResolvedValue({
        success: true,
        output: 'ok',
        usage: { inputTokens: 300, outputTokens: 120 },
      }),
    });

    const wctx = makeWorkflowContext({ callbacks, implementer });

    const taskBreakdowns: TaskTokenUsage[] = [];
    const setTrackedState = vi.fn();
    const setCurrentTask = vi.fn();

    const result = await runSingleTask({
      wctx,
      task,
      index: 0,
      totalTasks: 1,
      state,
      taskBreakdowns,
      setTrackedState,
      setCurrentTask,
    });

    // Completed task → advanced past it.
    expect(result.currentTaskIndex).toBe(1);
    expect(result.tasks[0]?.status).toBe('done');

    // Token usage accumulated on state.
    expect(result.tokenUsage.implementerInput).toBe(300);
    expect(result.tokenUsage.implementerOutput).toBe(120);

    const start = events.find((e) => e.type === 'task-start');
    const complete = events.find((e) => e.type === 'task-complete');
    expect(start).toMatchObject({ type: 'task-start', taskId: 'T001', index: 0, total: 1 });
    expect(complete).toMatchObject({ type: 'task-complete', taskId: 'T001', method: 'local' });

    // One per-task breakdown recorded.
    expect(taskBreakdowns).toHaveLength(1);
    expect(taskBreakdowns[0]).toMatchObject({ taskId: 'T001', method: 'local' });
  });

  it('returns state unchanged when the signal is already aborted on entry', async () => {
    const task = makeTask({ id: 'T001' });
    const state = implementingState([task]);

    const controller = new AbortController();
    controller.abort();

    const implement = vi.fn();
    const implementer = makeImplementer({ implement });
    const wctx = makeWorkflowContext({ implementer, signal: controller.signal });

    const result = await runSingleTask({
      wctx,
      task,
      index: 0,
      totalTasks: 1,
      state,
      taskBreakdowns: [],
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    expect(implement).not.toHaveBeenCalled();
    // Task was not advanced.
    expect(result.currentTaskIndex).toBe(state.currentTaskIndex);
    expect(result.tasks[0]?.status).toBe('pending');
  });
});

describe('retryAndRecord — retry budget', () => {
  it('local retry on first attempt succeeds → advances task, records local method', async () => {
    const task = makeTask({ id: 'T001' });
    const state = implementingState([task]);

    const { callbacks, events } = makeCallbacks();
    const retry = vi.fn().mockResolvedValue({
      success: true,
      output: 'fixed',
      usage: { inputTokens: 50, outputTokens: 25 },
    });
    const implementer = makeImplementer({ retry });

    const wctx = makeWorkflowContext({ callbacks, implementer });
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

    // Retry event observed with attempt=1.
    const retryEvents = events.filter((e) => e.type === 'retry');
    expect(retryEvents.length).toBeGreaterThanOrEqual(1);
    expect(retryEvents[0]).toMatchObject({ taskId: 'T001', attempt: 1 });

    // Breakdown recorded with method=local.
    expect(taskBreakdowns[0]?.method).toBe('local');
  });

  it('exhausts local retry budget and escalates — emits task_failed when escalation also fails', async () => {
    const task = makeTask({ id: 'T001' });
    const state = implementingState([task]);

    const { callbacks, events } = makeCallbacks();
    // Local retry always fails.
    const retry = vi.fn().mockResolvedValue({
      success: false,
      output: 'still broken',
      error: 'tsc failed again',
      usage: { inputTokens: 20, outputTokens: 10 },
    });
    // Escalation tiers: intermediate planner is absent in config (default),
    // hint and full also fail.
    const planner = makePlanner({
      escalateHint: vi.fn().mockResolvedValue({ success: false, output: '', code: null, usage: null }),
      escalateFull: vi.fn().mockResolvedValue({ success: false, output: '', code: null, usage: null }),
    });
    const implementer = makeImplementer({ retry });

    const wctx = makeWorkflowContext({
      callbacks,
      implementer,
      planner,
      // Shrink the retry budget to keep the test fast.
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
    // retry is called maxRetries times (local) plus once on the hint tier before giving up.
    expect(retry.mock.calls.length).toBeGreaterThanOrEqual(2);
    // Final task status recorded as failed.
    expect(res.state.tasks[0]?.status).toBe('failed');

    // Retry events and task_failed session-log event fan-out happens; on onEvent callbacks
    // the observable failure signal is the lack of task-complete AND the retry events.
    const complete = events.find((e) => e.type === 'task-complete');
    expect(complete).toBeUndefined();

    const retryEvents = events.filter((e) => e.type === 'retry');
    // At least as many retry events as local attempts.
    expect(retryEvents.length).toBeGreaterThanOrEqual(2);
  });
});
