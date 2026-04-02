import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WorkflowState, OrchestratorCallbacks, TuiEvent, ValidationResult } from '../../types.js';
import type { PlannerBackend } from '../planners/types.js';
import { createInitialState, transition } from '../../state.js';
import { makeTask, makeConfig, defaultContext } from '#testing/helpers/fixtures.js';

vi.mock('../implementer.js', () => ({
  implementTask: vi.fn(),
}));
vi.mock('../validator.js', () => ({
  validateTask: vi.fn(),
  formatValidationError: vi.fn().mockReturnValue('validation error'),
}));
vi.mock('../../utils/git.js', () => ({
  hasExternalChanges: vi.fn().mockResolvedValue(false),
  commitChanges: vi.fn(),
}));
vi.mock('../../state-persistence.js', () => ({
  saveState: vi.fn(),
  loadState: vi.fn(),
  appendEvent: vi.fn(),
}));
vi.mock('./escalation.js', () => ({
  handleRetryAndEscalation: vi.fn(),
}));

import { hasDependencyFailed, runTaskLoop } from './task-loop.js';
import { implementTask } from '../implementer.js';
import { validateTask } from '../validator.js';
import { commitChanges } from '../../utils/git.js';
import { loadState } from '../../state-persistence.js';

beforeEach(() => {
  vi.clearAllMocks();
});

function makeCallbacks(): { callbacks: OrchestratorCallbacks; events: TuiEvent[] } {
  const events: TuiEvent[] = [];
  return {
    events,
    callbacks: {
      onEvent: (e) => events.push(e),
      onApprovalNeeded: vi.fn().mockResolvedValue({ approved: true }),
      onExternalChanges: vi.fn().mockResolvedValue(false),
      onComplete: vi.fn(),
    },
  };
}

function makePlanner(): PlannerBackend {
  return {
    name: 'test',
    conversational: false,
    plan: vi.fn(),
    regenerate: vi.fn(),
    escalateHint: vi.fn(),
    escalateFull: vi.fn(),
    isAvailable: vi.fn().mockResolvedValue(true),
    getVersion: vi.fn().mockResolvedValue('1.0'),
    getPricing: vi.fn().mockReturnValue({ inputPer1M: 0, outputPer1M: 0 }),
  };
}

const passingResults: ValidationResult[] = [
  { passed: true, stage: 'typecheck' },
  { passed: true, stage: 'lint' },
  { passed: true, stage: 'test' },
];

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

describe('hasDependencyFailed', () => {
  it('returns true when a dependency is in failed list', () => {
    const task = makeTask({ dependsOn: ['T001'] });
    expect(hasDependencyFailed(task, ['T001'], [])).toBe(true);
  });

  it('returns true when a dependency is in skipped list', () => {
    const task = makeTask({ dependsOn: ['T001'] });
    expect(hasDependencyFailed(task, [], ['T001'])).toBe(true);
  });

  it('returns false when no dependencies are blocked', () => {
    const task = makeTask({ dependsOn: ['T001'] });
    expect(hasDependencyFailed(task, [], [])).toBe(false);
  });

  it('returns false when task has no dependencies', () => {
    const task = makeTask({ dependsOn: [] });
    expect(hasDependencyFailed(task, ['T099'], ['T098'])).toBe(false);
  });
});

describe('runTaskLoop', () => {
  it('task with failed dependency is skipped and emits task-skipped event', async () => {
    const t1 = makeTask({ id: 'T001' });
    const t2 = makeTask({ id: 'T002', dependsOn: ['T001'] });
    let state = makeImplState([t1, t2]);
    // Simulate T001 failed
    state = { ...state, currentTaskIndex: 1, failedTasks: ['T001'] };

    const { callbacks, events } = makeCallbacks();

    const result = await runTaskLoop({
      projectDir: '/tmp/proj',
      config: makeConfig(),
      callbacks,
      context: defaultContext,
      planner: makePlanner(),
      initialState: state,
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    const skipEvent = events.find((e) => e.type === 'task-skipped');
    expect(skipEvent).toBeDefined();
    expect(skipEvent).toMatchObject({ taskId: 'T002' });
    expect(result.state.skippedTasks).toContain('T002');
  });

  it('happy path: implement → validate pass → commit', async () => {
    const task = makeTask({ id: 'T001' });
    const state = makeImplState([task]);

    vi.mocked(implementTask).mockResolvedValue({
      success: true,
      output: 'code',
      usage: { inputTokens: 100, outputTokens: 50 },
    });
    vi.mocked(validateTask).mockResolvedValue(passingResults);
    vi.mocked(commitChanges).mockResolvedValue();

    const { callbacks, events } = makeCallbacks();
    const setCurrentTask = vi.fn();

    const result = await runTaskLoop({
      projectDir: '/tmp/proj',
      config: makeConfig({ workflow: { commitPerTask: true } }),
      callbacks,
      context: defaultContext,
      planner: makePlanner(),
      initialState: state,
      setTrackedState: vi.fn(),
      setCurrentTask,
    });

    expect(implementTask).toHaveBeenCalledTimes(1);
    expect(validateTask).toHaveBeenCalledTimes(1);
    const taskStart = events.find((e) => e.type === 'task-start');
    expect(taskStart).toBeDefined();
    expect(setCurrentTask).toHaveBeenCalledWith(expect.objectContaining({ id: 'T001' }));
    // setCurrentTask(undefined) is called at the end of the loop
    expect(setCurrentTask).toHaveBeenLastCalledWith(undefined);
  });

  it('token usage accumulated via state persistence', async () => {
    const task = makeTask({ id: 'T001' });
    const state = makeImplState([task]);

    vi.mocked(implementTask).mockResolvedValue({
      success: true,
      output: 'code',
      usage: { inputTokens: 500, outputTokens: 200 },
    });
    vi.mocked(validateTask).mockResolvedValue(passingResults);
    vi.mocked(commitChanges).mockResolvedValue();

    const { callbacks } = makeCallbacks();

    const result = await runTaskLoop({
      projectDir: '/tmp/proj',
      config: makeConfig(),
      callbacks,
      context: defaultContext,
      planner: makePlanner(),
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

    const { hasExternalChanges } = await import('../../utils/git.js');
    vi.mocked(hasExternalChanges).mockResolvedValue(true);

    const onExternalChanges = vi.fn().mockResolvedValue(false);
    const { callbacks } = makeCallbacks();
    callbacks.onExternalChanges = onExternalChanges;

    const result = await runTaskLoop({
      projectDir: '/tmp/proj',
      config: makeConfig(),
      callbacks,
      context: defaultContext,
      planner: makePlanner(),
      initialState: state,
      setTrackedState: vi.fn(),
      setCurrentTask: vi.fn(),
    });

    expect(onExternalChanges).toHaveBeenCalled();
    // When external changes detected and user declines, phase should be cancelled
    expect(result.state.phase).not.toBe('implementing');
  });
});
