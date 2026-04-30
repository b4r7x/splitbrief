import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import {
  makeBusRecorder,
  makeCallbacks,
  makeImplementer,
  makePlanner,
} from '#testing/helpers/orchestrator-factories.js';
import { makeConfig, defaultContext } from '#testing/helpers/factories/config.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { createTestGitRepo } from '#testing/helpers/git.js';
import { ensureSessionDir } from '../../../core/paths-io.js';
import { createInitialState, transition } from '../../../core/state/machine.js';
import { loadState } from '../../../core/state/persistence.js';
import type { Task } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { createValidator } from '../validation.js';
import type { WorkflowContext, WorkflowSinks } from '../types.js';
import { retryAndRecord } from './retry.js';

let dirs: string[] = [];

afterEach(() => {
  vi.clearAllMocks();
  for (const dir of dirs) cleanupTempDir(dir);
  dirs = [];
});

function makeSinks(): WorkflowSinks {
  return { setAbortHandler: () => {}, setQueueHandler: () => {} };
}

function implementingState(tasks: Task[]): WorkflowState {
  const firstTask = tasks[0];
  if (!firstTask) throw new Error('implementingState requires at least one task');
  let state = createInitialState('feat');
  state = transition(state, { type: 'START', feature: 'feat' });
  state = transition(state, { type: 'RESEARCH_DONE' });
  state = transition(state, { type: 'SPEC_DONE' });
  state = transition(state, { type: 'APPROVE_SPEC' });
  state = transition(state, { type: 'PLAN_DONE', tasks });
  state = transition(state, { type: 'APPROVE_PLAN' });
  state = transition(state, { type: 'START_TASK', taskId: firstTask.id });
  state = transition(state, { type: 'TASK_SENT' });
  return {
    ...state,
    implementerTool: 'ollama',
    implementerModel: 'qwen2.5',
    plannerTool: 'claude-code',
  };
}

function makeWorkflowContext(
  projectDir: string,
  sessionId: string,
  overrides?: Partial<Pick<WorkflowContext, 'bus' | 'config' | 'implementer' | 'planner'>>,
): WorkflowContext {
  const { callbacks } = makeCallbacks();
  return {
    projectDir,
    sessionId,
    config: overrides?.config ?? makeConfig({
      validation: { typecheck: false, lint: false, test: false, testCommand: 'noop' },
      workflow: { commitStrategy: 'none', maxRetries: 2 },
    }),
    callbacks,
    bus: overrides?.bus ?? makeBusRecorder().bus,
    planner: overrides?.planner ?? makePlanner(),
    implementer: overrides?.implementer ?? makeImplementer(),
    context: defaultContext,
    metadata: { plannerTool: 'claude-code', implementerTool: 'ollama', mode: 'standard' },
    sinks: makeSinks(),
    validator: createValidator(),
  };
}

describe('retryAndRecord recovery stop points', () => {
  it('persists pending recovery when retry or escalation throws before returning a result', async () => {
    const projectDir = createTempDir('task-step-recovery');
    dirs.push(projectDir);
    const sessionId = 'sess-task-step-recovery';
    ensureSessionDir(projectDir, sessionId);

    const task = makeTask({ id: 'T001' });
    const state = implementingState([task]);
    const { bus, events } = makeBusRecorder();
    const planner = makePlanner({
      escalateHint: vi.fn().mockRejectedValueOnce(new Error('planner crashed')),
    });
    const implementer = makeImplementer({ retry: vi.fn() });
    const wctx = makeWorkflowContext(projectDir, sessionId, {
      bus,
      planner,
      implementer,
      config: makeConfig({
        validation: { typecheck: false, lint: false, test: false, testCommand: 'noop' },
        workflow: { commitStrategy: 'none', maxRetries: 0 },
      }),
    });
    const setTrackedState = vi.fn();

    const result = await retryAndRecord({
      wctx,
      task,
      initialError: 'initial validation failed',
      state,
      taskStartTime: Date.now(),
      taskStartSnapshot: { head: 'HEAD', files: [], dirtyFileContents: {} },
      tokensBefore: { ...state.tokenUsage },
      taskBreakdowns: [],
      setTrackedState,
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
    expect(setTrackedState).toHaveBeenCalledWith(expect.objectContaining({
      pendingRecovery: expect.objectContaining({ reason: 'retry-exhausted' }),
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: 'recovery_prompted',
      reason: 'retry-exhausted',
      taskId: 'T001',
      availableActions: ['retry-same-worker', 'planner-split-rebase', 'skip-current-task', 'pause-run', 'abort-workflow'],
    }));
  });

  it('adds recovery to the latest persisted retry state when a later retry step throws', async () => {
    const projectDir = createTempDir('task-step-recovery');
    dirs.push(projectDir);
    createTestGitRepo(projectDir);
    const sessionId = 'sess-task-step-recovery';
    ensureSessionDir(projectDir, sessionId);

    const task = makeTask({ id: 'T001' });
    const state = implementingState([task]);
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
    const wctx = makeWorkflowContext(projectDir, sessionId, {
      bus,
      implementer,
      planner,
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
