import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WorkflowState, ValidationResult, Task } from '../../types.js';
import { createInitialState } from '../../core/state/machine.js';
import { makeTask, makeConfig } from '#testing/helpers/fixtures.js';
import { makeCallbacks, passingResults } from '#testing/helpers/orchestrator-fixtures.js';

function firstTask(state: WorkflowState): Task {
  const t = state.tasks[0];
  if (!t) throw new Error('expected first task in state');
  return t;
}

vi.mock('../../utils/git.js', () => ({
  commitChanges: vi.fn(),
}));
vi.mock('./git-ops.js', () => ({
  createCheckpoint: vi.fn(),
}));
vi.mock('../../core/state/persistence.js', () => ({
  saveState: vi.fn(),
  appendEvent: vi.fn(),
}));

import { validateCommitAndAdvance } from './task-commit.js';
import { commitChanges } from '../../utils/git.js';
import { createCheckpoint } from './git-ops.js';
import { saveState } from '../../core/state/persistence.js';

beforeEach(() => {
  vi.clearAllMocks();
});

function makeState(overrides?: Partial<WorkflowState>): WorkflowState {
  const base = createInitialState('test-feature');
  const task = makeTask();
  return {
    ...base,
    phase: 'validating-task',
    tasks: [task],
    currentTaskIndex: 0,
    attempt: 0,
    ...overrides,
  };
}

const failingResults: ValidationResult[] = [
  { passed: true, stage: 'tsc' },
  { passed: false, stage: 'lint', error: 'Lint error' },
];

describe('validateCommitAndAdvance', () => {
  it('returns completed: false when validation fails', async () => {
    const state = makeState();
    const { callbacks } = makeCallbacks();

    const result = await validateCommitAndAdvance({
      task: firstTask(state),
      results: failingResults,
      projectDir: '/tmp/proj',
      config: makeConfig(),
      state,
      callbacks,
      method: 'local',
      transitionType: 'VALIDATION_PASS',
    });

    expect(result.completed).toBe(false);
    expect(result.state).toBe(state);
    expect(commitChanges).not.toHaveBeenCalled();
    expect(saveState).not.toHaveBeenCalled();
  });

  it('returns completed: true when all validations pass', async () => {
    const state = makeState();
    const { callbacks } = makeCallbacks();

    const result = await validateCommitAndAdvance({
      task: firstTask(state),
      results: passingResults,
      projectDir: '/tmp/proj',
      config: makeConfig(),
      state,
      callbacks,
      method: 'local',
      transitionType: 'VALIDATION_PASS',
    });

    expect(result.completed).toBe(true);
    expect(saveState).toHaveBeenCalled();
  });

  it('commits when commitStrategy is per-task and validation passes', async () => {
    const state = makeState();
    const { callbacks } = makeCallbacks();
    vi.mocked(commitChanges).mockResolvedValue('abc123');

    const result = await validateCommitAndAdvance({
      task: firstTask(state),
      results: passingResults,
      projectDir: '/tmp/proj',
      config: makeConfig({ workflow: { commitStrategy: 'per-task' } }),
      state,
      callbacks,
      method: 'local',
      transitionType: 'VALIDATION_PASS',
    });

    expect(result.completed).toBe(true);
    expect(commitChanges).toHaveBeenCalled();
  });

  it('does not commit when commitStrategy is none', async () => {
    const state = makeState();
    const { callbacks } = makeCallbacks();

    await validateCommitAndAdvance({
      task: firstTask(state),
      results: passingResults,
      projectDir: '/tmp/proj',
      config: makeConfig({ workflow: { commitStrategy: 'none' } }),
      state,
      callbacks,
      method: 'local',
      transitionType: 'VALIDATION_PASS',
    });

    expect(commitChanges).not.toHaveBeenCalled();
    expect(createCheckpoint).not.toHaveBeenCalled();
  });

  it('emits git-commit event on successful commit', async () => {
    const state = makeState();
    const { callbacks, events } = makeCallbacks();
    vi.mocked(commitChanges).mockResolvedValue('abc123');

    await validateCommitAndAdvance({
      task: firstTask(state),
      results: passingResults,
      projectDir: '/tmp/proj',
      config: makeConfig({ workflow: { commitStrategy: 'per-task' } }),
      state,
      callbacks,
      method: 'local',
      transitionType: 'VALIDATION_PASS',
    });

    const gitEvent = events.find((e) => e.type === 'git-commit');
    expect(gitEvent).toBeDefined();
  });

  it('creates checkpoint when commitStrategy is checkpoint', async () => {
    const state = makeState();
    const { callbacks, events } = makeCallbacks();
    vi.mocked(createCheckpoint).mockResolvedValue('tiny-spec/T001');

    await validateCommitAndAdvance({
      task: firstTask(state),
      results: passingResults,
      projectDir: '/tmp/proj',
      config: makeConfig({ workflow: { commitStrategy: 'checkpoint' } }),
      state,
      callbacks,
      method: 'local',
      transitionType: 'VALIDATION_PASS',
    });

    expect(createCheckpoint).toHaveBeenCalledWith('/tmp/proj', 'T001');
    expect(commitChanges).not.toHaveBeenCalled();
    const cpEvent = events.find((e) => e.type === 'git-checkpoint');
    expect(cpEvent).toBeDefined();
    expect(cpEvent).toMatchObject({
      type: 'git-checkpoint',
      tag: 'tiny-spec/T001',
      taskId: 'T001',
    });
  });

  it('emits task-complete event with results', async () => {
    const state = makeState();
    const { callbacks, events } = makeCallbacks();
    vi.mocked(commitChanges).mockResolvedValue('abc123');

    await validateCommitAndAdvance({
      task: firstTask(state),
      results: passingResults,
      projectDir: '/tmp/proj',
      config: makeConfig(),
      state,
      callbacks,
      method: 'local',
      transitionType: 'VALIDATION_PASS',
    });

    const taskEvent = events.find((e) => e.type === 'task-complete');
    expect(taskEvent).toBeDefined();
    expect(taskEvent).toMatchObject({
      type: 'task-complete',
      taskId: 'T001',
      method: 'local',
    });
  });

  it('uses explicit retryCount over state.attempt when provided', async () => {
    const state = makeState({ attempt: 1 });
    const { callbacks, events } = makeCallbacks();

    await validateCommitAndAdvance({
      task: firstTask(state),
      results: passingResults,
      projectDir: '/tmp/proj',
      config: makeConfig(),
      state,
      callbacks,
      method: 'escalated-hint',
      transitionType: 'HINT_SUCCESS',
      retryCount: 3,
    });

    const taskEvent = events.find((e) => e.type === 'task-complete');
    expect(taskEvent).toBeDefined();
    expect(taskEvent).toMatchObject({ type: 'task-complete', retries: 3 });
  });

  it('falls back to state.attempt when retryCount is not provided', async () => {
    const state = makeState({ attempt: 2 });
    const { callbacks, events } = makeCallbacks();

    await validateCommitAndAdvance({
      task: firstTask(state),
      results: passingResults,
      projectDir: '/tmp/proj',
      config: makeConfig(),
      state,
      callbacks,
      method: 'local',
      transitionType: 'VALIDATION_PASS',
    });

    const taskEvent = events.find((e) => e.type === 'task-complete');
    expect(taskEvent).toMatchObject({ type: 'task-complete', retries: 2 });
  });
});
