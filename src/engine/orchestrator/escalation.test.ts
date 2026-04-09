import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WorkflowState } from '../../types.js';
import { createInitialState, transition } from '../../core/state/machine.js';
import { makeTask, makeConfig, defaultContext } from '#testing/helpers/fixtures.js';
import { makeCallbacks, makePlanner, makeImplementer, passingResults, failingResults } from '#testing/helpers/orchestrator-fixtures.js';
vi.mock('./validator.js', () => ({
  validateTask: vi.fn(),
  runValidationWithEvents: vi.fn(),
  formatValidationError: vi.fn().mockReturnValue('validation error'),
}));
vi.mock('./git-ops.js', () => ({
  discardTaskChanges: vi.fn(),
}));
vi.mock('../../utils/git.js', () => ({
  commitChanges: vi.fn(),
}));
vi.mock('../../core/state/persistence.js', () => ({
  saveState: vi.fn(),
  appendEvent: vi.fn(),
}));

import { handleRetryAndEscalation } from './escalation.js';
import { runValidationWithEvents } from './validator.js';
import { discardTaskChanges } from './git-ops.js';

beforeEach(() => {
  vi.clearAllMocks();
});

function makeValidatingState(): WorkflowState {
  const task = makeTask();
  let state = createInitialState('feat');
  state = transition(state, { type: 'START', feature: 'feat' });
  state = transition(state, { type: 'RESEARCH_DONE' });
  state = transition(state, { type: 'SPEC_DONE' });
  state = transition(state, { type: 'APPROVE_SPEC' });
  state = transition(state, { type: 'PLAN_DONE', tasks: [task] });
  state = transition(state, { type: 'APPROVE_PLAN' });
  state = transition(state, { type: 'TASK_SENT' });
  return state;
}

describe('handleRetryAndEscalation', () => {
  it('retry succeeds on attempt 1 → returns completed with local method', async () => {
    const { callbacks } = makeCallbacks();
    const planner = makePlanner();
    const task = makeTask();
    const config = makeConfig({ workflow: { maxRetries: 3 } });
    const state = makeValidatingState();
    const implementer = makeImplementer();

    vi.mocked(runValidationWithEvents).mockResolvedValue(passingResults);

    const { result } = await handleRetryAndEscalation({
      wctx: { projectDir: '/tmp/proj', config, context: defaultContext, planner, callbacks, implementer },
      task, initialError: 'type error', currentState: state,
    });

    expect(result.completed).toBe(true);
    expect(result.method).toBe('local');
  });

  it('all retries fail → transitions to hint escalation', async () => {
    const { callbacks } = makeCallbacks();
    const planner = makePlanner();
    const task = makeTask();
    const config = makeConfig({ workflow: { maxRetries: 2 } });
    const state = makeValidatingState();
    const implementer = makeImplementer({
      retry: vi.fn().mockResolvedValue({ success: false, output: '', error: 'still broken', usage: { inputTokens: 10, outputTokens: 5 } }),
    });

    // Hint retry also fails
    vi.mocked(runValidationWithEvents).mockResolvedValue(failingResults);

    const { result } = await handleRetryAndEscalation({
      wctx: { projectDir: '/tmp/proj', config, context: defaultContext, planner, callbacks, implementer },
      task, initialError: 'error', currentState: state,
    });

    // Local retries exhausted, planner hint escalation engaged, but it also failed → not completed
    expect(result.completed).toBe(false);
  });

  it('hint escalation success: planner hint helps, local retry succeeds', async () => {
    const { callbacks } = makeCallbacks();
    const task = makeTask();
    const config = makeConfig({ workflow: { maxRetries: 1 } });
    const state = makeValidatingState();

    const implementer = makeImplementer({
      retry: vi.fn()
        // Local retry fails
        .mockResolvedValueOnce({ success: false, output: '', error: 'fail', usage: { inputTokens: 10, outputTokens: 5 } })
        // Hint-assisted retry succeeds
        .mockResolvedValueOnce({ success: true, output: 'fixed', usage: { inputTokens: 20, outputTokens: 10 } }),
    });

    vi.mocked(runValidationWithEvents).mockResolvedValue(passingResults);

    const planner = makePlanner({
      escalateHint: vi.fn().mockResolvedValue({ success: true, output: 'try adding import', code: null, usage: { inputTokens: 100, outputTokens: 50 } }),
    });

    const { result } = await handleRetryAndEscalation({
      wctx: { projectDir: '/tmp/proj', config, context: defaultContext, planner, callbacks, implementer },
      task, initialError: 'error', currentState: state,
    });

    expect(result.completed).toBe(true);
    expect(result.method).toBe('escalated-hint');
  });

  it('full escalation: planner writes code that passes validation', async () => {
    const { callbacks } = makeCallbacks();
    const task = makeTask();
    const config = makeConfig({ workflow: { maxRetries: 1 } });
    const state = makeValidatingState();

    const implementer = makeImplementer({
      retry: vi.fn().mockResolvedValue({ success: false, output: '', error: 'fail', usage: { inputTokens: 10, outputTokens: 5 } }),
    });

    // retry always fails so validation is only called in tier2's validateAndCommit
    vi.mocked(runValidationWithEvents).mockResolvedValueOnce(passingResults);

    const planner = makePlanner({
      escalateHint: vi.fn().mockResolvedValue({ success: true, output: 'hint', code: null, usage: { inputTokens: 50, outputTokens: 25 } }),
      escalateFull: vi.fn().mockResolvedValue({ success: true, output: 'full code', code: 'code', usage: { inputTokens: 200, outputTokens: 100 } }),
    });

    const { result } = await handleRetryAndEscalation({
      wctx: { projectDir: '/tmp/proj', config, context: defaultContext, planner, callbacks, implementer },
      task, initialError: 'error', currentState: state,
    });

    expect(result.completed).toBe(true);
    expect(result.method).toBe('escalated-full');
  });

  it('full escalation fails → task marked as failed, discardTaskChanges called', async () => {
    const { callbacks } = makeCallbacks();
    const task = makeTask();
    const config = makeConfig({ workflow: { maxRetries: 1 } });
    const state = makeValidatingState();

    const implementer = makeImplementer({
      retry: vi.fn().mockResolvedValue({ success: false, output: '', error: 'fail', usage: { inputTokens: 10, outputTokens: 5 } }),
    });
    vi.mocked(runValidationWithEvents).mockResolvedValue(failingResults);

    const planner = makePlanner({
      escalateHint: vi.fn().mockResolvedValue({ success: true, output: 'hint', code: null, usage: null }),
      escalateFull: vi.fn().mockResolvedValue({ success: false, output: '', code: null, usage: null }),
    });

    const { result } = await handleRetryAndEscalation({
      wctx: { projectDir: '/tmp/proj', config, context: defaultContext, planner, callbacks, implementer },
      task, initialError: 'error', currentState: state,
    });

    expect(result.completed).toBe(false);
    expect(result.method).toBe('failed');
    expect(discardTaskChanges).toHaveBeenCalled();
  });

});
