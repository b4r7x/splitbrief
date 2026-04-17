import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WorkflowState } from '../../core/types/state-actions.js';
import { createInitialState, transition } from '../../core/state/machine.js';
import { getSkippedTaskIds } from '../../core/state/selectors.js';
import { makeTask, makeConfig, defaultContext } from '#testing/helpers/fixtures.js';
import { makeCallbacks, makePlanner, makeImplementer, passingResults } from '#testing/helpers/orchestrator-fixtures.js';

vi.mock('./validation.js', () => ({
  validateTask: vi.fn(),
  runValidationWithEvents: vi.fn(),
  formatValidationError: vi.fn().mockReturnValue('validation error'),
}));
vi.mock('../../lib/git.js', () => ({
  hasExternalChanges: vi.fn().mockResolvedValue(false),
  commitChanges: vi.fn(),
}));
vi.mock('../../core/state/persistence.js', () => ({
  saveState: vi.fn(),
  loadState: vi.fn(),
  appendEvent: vi.fn(),
}));

import { runTaskLoop } from './task-loop.js';
import { runValidationWithEvents } from './validation.js';
import { commitChanges } from '../../lib/git.js';
import type { WorkflowSinks } from './types.js';

const TEST_METADATA = { plannerTool: 'claude-code', implementerTool: 'ollama', mode: 'standard' };

const TEST_SINKS: WorkflowSinks = {
  setAbortHandler: () => {},
  setQueueHandler: () => {},
};

beforeEach(() => {
  vi.clearAllMocks();
});

function makeImplState(tasks: ReturnType<typeof makeTask>[]): WorkflowState {
  let state = createInitialState('feat');
  state = transition(state, { type: 'START', feature: 'feat' });
  state = transition(state, { type: 'RESEARCH_DONE' });
  state = transition(state, { type: 'SPEC_DONE' });
  state = transition(state, { type: 'APPROVE_SPEC' });
  state = transition(state, { type: 'PLAN_DONE', tasks });
  state = transition(state, { type: 'APPROVE_PLAN' });
  return state;
}

describe('runTaskLoop', () => {
  it('task with failed dependency is skipped and emits task-skipped event', async () => {
    const t1 = makeTask({ id: 'T001', status: 'failed' });
    const t2 = makeTask({ id: 'T002', dependsOn: ['T001'] });
    let state = makeImplState([t1, t2]);
    // Simulate T001 failed: set status and advance index past it.
    state = {
      ...state,
      currentTaskIndex: 1,
      tasks: state.tasks.map((t) => (t.id === 'T001' ? { ...t, status: 'failed' } : t)),
    };

    const { callbacks, events } = makeCallbacks();

    const result = await runTaskLoop({
      wctx: { projectDir: '/tmp/proj', config: makeConfig(), callbacks, context: defaultContext, planner: makePlanner(), implementer: makeImplementer(), metadata: TEST_METADATA, sessionId: 'test-session', sinks: TEST_SINKS },
      initialState: state,
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    const skipEvent = events.find((e) => e.type === 'task-skipped');
    expect(skipEvent).toBeDefined();
    expect(skipEvent).toMatchObject({ taskId: 'T002' });
    expect(getSkippedTaskIds(result.state)).toContain('T002');
  });

  it('happy path: implement → validate pass → commit', async () => {
    const task = makeTask({ id: 'T001' });
    const state = makeImplState([task]);

    const implementer = makeImplementer();
    vi.mocked(runValidationWithEvents).mockResolvedValue(passingResults);
    vi.mocked(commitChanges).mockResolvedValue('abc123');

    const { callbacks, events } = makeCallbacks();

    await runTaskLoop({
      wctx: { projectDir: '/tmp/proj', config: makeConfig({ workflow: { commitStrategy: 'per-task' } }), callbacks, context: defaultContext, planner: makePlanner(), implementer, metadata: TEST_METADATA, sessionId: 'test-session', sinks: TEST_SINKS },
      initialState: state,
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    const taskStart = events.find((e) => e.type === 'task-start');
    expect(taskStart).toBeDefined();
    expect(taskStart).toMatchObject({ type: 'task-start', taskId: 'T001', index: 0, total: 1 });
    const taskComplete = events.find((e) => e.type === 'task-complete');
    expect(taskComplete).toBeDefined();
    expect(taskComplete).toMatchObject({ type: 'task-complete', taskId: 'T001', method: 'local' });
  });

  it('token usage accumulated via state persistence', async () => {
    const task = makeTask({ id: 'T001' });
    const state = makeImplState([task]);

    const implementer = makeImplementer({
      implement: vi.fn().mockResolvedValue({ success: true, output: 'code', usage: { inputTokens: 500, outputTokens: 200 } }),
    });
    vi.mocked(runValidationWithEvents).mockResolvedValue(passingResults);
    vi.mocked(commitChanges).mockResolvedValue('abc123');

    const { callbacks } = makeCallbacks();

    const result = await runTaskLoop({
      wctx: { projectDir: '/tmp/proj', config: makeConfig(), callbacks, context: defaultContext, planner: makePlanner(), implementer, metadata: TEST_METADATA, sessionId: 'test-session', sinks: TEST_SINKS },
      initialState: state,
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    // Token usage should have been updated
    expect(result.state.tokenUsage.implementerInput).toBe(500);
    expect(result.state.tokenUsage.implementerOutput).toBe(200);
  });

  it('external changes detected → callback called and workflow cancelled', async () => {
    const task = makeTask({ id: 'T001' });
    const state = makeImplState([task]);

    const { hasExternalChanges } = await import('../../lib/git.js');
    vi.mocked(hasExternalChanges).mockResolvedValue(true);

    const onExternalChanges = vi.fn().mockResolvedValue(false);
    const { callbacks } = makeCallbacks();
    callbacks.onExternalChanges = onExternalChanges;

    const result = await runTaskLoop({
      wctx: { projectDir: '/tmp/proj', config: makeConfig(), callbacks, context: defaultContext, planner: makePlanner(), implementer: makeImplementer(), metadata: TEST_METADATA, sessionId: 'test-session', sinks: TEST_SINKS },
      initialState: state,
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    expect(onExternalChanges).toHaveBeenCalled();
    // When external changes detected and user declines, phase should be cancelled
    expect(result.state.phase).not.toBe('implementing');
  });
});
