import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WorkflowState, OrchestratorCallbacks, TuiEvent, ValidationResult } from '../../types.js';
import { createInitialState } from '../../core/state.js';
import { makeTask, makeConfig } from '#testing/helpers/fixtures.js';

vi.mock('../../utils/git.js', () => ({
  commitChanges: vi.fn(),
}));
vi.mock('../../core/state-persistence.js', () => ({
  saveState: vi.fn(),
  appendEvent: vi.fn(),
}));

import { validateCommitAndAdvance } from './task-runner.js';
import { commitChanges } from '../../utils/git.js';
import { saveState } from '../../core/state-persistence.js';

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

const passingResults: ValidationResult[] = [
  { passed: true, stage: 'typecheck' },
  { passed: true, stage: 'lint' },
  { passed: true, stage: 'test' },
];

const failingResults: ValidationResult[] = [
  { passed: true, stage: 'typecheck' },
  { passed: false, stage: 'lint', error: 'Lint error' },
];

describe('validateCommitAndAdvance', () => {
  it('returns completed: false when validation fails', async () => {
    const state = makeState();
    const { callbacks } = makeCallbacks();

    const result = await validateCommitAndAdvance({
      task: state.tasks[0],
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
      task: state.tasks[0],
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

  it('commits when commitPerTask is true and validation passes', async () => {
    const state = makeState();
    const { callbacks } = makeCallbacks();
    vi.mocked(commitChanges).mockResolvedValue();

    const result = await validateCommitAndAdvance({
      task: state.tasks[0],
      results: passingResults,
      projectDir: '/tmp/proj',
      config: makeConfig({ workflow: { commitPerTask: true } }),
      state,
      callbacks,
      method: 'local',
      transitionType: 'VALIDATION_PASS',
    });

    expect(result.completed).toBe(true);
    expect(commitChanges).toHaveBeenCalledWith('/tmp/proj', expect.stringContaining('T001'));
  });

  it('does not commit when commitPerTask is false', async () => {
    const state = makeState();
    const { callbacks } = makeCallbacks();

    await validateCommitAndAdvance({
      task: state.tasks[0],
      results: passingResults,
      projectDir: '/tmp/proj',
      config: makeConfig({ workflow: { commitPerTask: false } }),
      state,
      callbacks,
      method: 'local',
      transitionType: 'VALIDATION_PASS',
    });

    expect(commitChanges).not.toHaveBeenCalled();
  });

  it('emits git-commit event on successful commit', async () => {
    const state = makeState();
    const { callbacks, events } = makeCallbacks();
    vi.mocked(commitChanges).mockResolvedValue();

    await validateCommitAndAdvance({
      task: state.tasks[0],
      results: passingResults,
      projectDir: '/tmp/proj',
      config: makeConfig({ workflow: { commitPerTask: true } }),
      state,
      callbacks,
      method: 'local',
      transitionType: 'VALIDATION_PASS',
    });

    const gitEvent = events.find((e) => e.type === 'git-commit');
    expect(gitEvent).toBeDefined();
    expect(gitEvent).toMatchObject({
      type: 'git-commit',
      message: expect.stringContaining('T001'),
    });
  });

  it('emits task-complete event with results', async () => {
    const state = makeState();
    const { callbacks, events } = makeCallbacks();
    vi.mocked(commitChanges).mockResolvedValue();

    await validateCommitAndAdvance({
      task: state.tasks[0],
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
});
