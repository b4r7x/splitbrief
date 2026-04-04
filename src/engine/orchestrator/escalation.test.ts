import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { OrchestratorCallbacks, TuiEvent, ValidationResult, WorkflowState } from '../../types.js';
import type { PlannerBackend } from '../planners/types.js';
import type { ImplementerBackend } from '../implementers/types.js';
import { createInitialState, transition } from '../../core/state.js';
import { makeTask, makeConfig, defaultContext } from '#testing/helpers/fixtures.js';
vi.mock('../validator.js', () => ({
  validateTask: vi.fn(),
  formatValidationError: vi.fn().mockReturnValue('validation error'),
}));
vi.mock('../../utils/git.js', () => ({
  discardTaskChanges: vi.fn(),
  commitChanges: vi.fn(),
}));
vi.mock('../../core/state-persistence.js', () => ({
  saveState: vi.fn(),
  appendEvent: vi.fn(),
}));

import { handleRetryAndEscalation } from './escalation.js';
import { validateTask } from '../validator.js';
import { discardTaskChanges } from '../../utils/git.js';

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

function makePlanner(overrides?: Partial<PlannerBackend>): PlannerBackend {
  return {
    name: 'test',
    conversational: false,
    plan: vi.fn(),
    regenerate: vi.fn(),
    escalateHint: vi.fn().mockResolvedValue({ success: false, output: 'hint text', code: null, usage: { inputTokens: 10, outputTokens: 5 } }),
    escalateFull: vi.fn().mockResolvedValue({ success: false, output: '', code: null, usage: { inputTokens: 20, outputTokens: 10 } }),
    isAvailable: vi.fn().mockResolvedValue(true),
    getVersion: vi.fn().mockResolvedValue('1.0'),
    getPricing: vi.fn().mockReturnValue({ inputPer1M: 0, outputPer1M: 0 }),
    ...overrides,
  };
}

function makeImplementer(overrides?: Partial<ImplementerBackend>): ImplementerBackend {
  return {
    name: 'test',
    implement: vi.fn().mockResolvedValue({ success: true, output: 'code', usage: { inputTokens: 50, outputTokens: 25 } }),
    retry: vi.fn().mockResolvedValue({ success: true, output: 'fixed code', usage: { inputTokens: 50, outputTokens: 25 } }),
    isAvailable: vi.fn().mockResolvedValue(true),
    getPricing: vi.fn().mockReturnValue({ inputPer1M: 0, outputPer1M: 0 }),
    ...overrides,
  };
}

const passingResults: ValidationResult[] = [
  { passed: true, stage: 'typecheck' },
  { passed: true, stage: 'lint' },
  { passed: true, stage: 'test' },
];

const failingResults: ValidationResult[] = [
  { passed: false, stage: 'typecheck', error: 'TS error' },
];

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

    vi.mocked(validateTask).mockResolvedValue(passingResults);

    const result = await handleRetryAndEscalation({
      task, initialError: 'type error', projectDir: '/tmp/proj',
      config, context: defaultContext, planner, callbacks, currentState: state, implementer,
    });

    expect(result.completed).toBe(true);
    expect(result.method).toBe('local');
    expect(implementer.retry).toHaveBeenCalledTimes(1);
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
    vi.mocked(validateTask).mockResolvedValue(failingResults);

    const result = await handleRetryAndEscalation({
      task, initialError: 'error', projectDir: '/tmp/proj',
      config, context: defaultContext, planner, callbacks, currentState: state, implementer,
    });

    // Planner should have been called for escalation
    expect(planner.escalateHint).toHaveBeenCalled();
    // retry called: 2 local retries + 1 hint retry = 3
    expect(implementer.retry).toHaveBeenCalledTimes(3);
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

    vi.mocked(validateTask).mockResolvedValue(passingResults);

    const planner = makePlanner({
      escalateHint: vi.fn().mockResolvedValue({ success: true, output: 'try adding import', code: null, usage: { inputTokens: 100, outputTokens: 50 } }),
    });

    const result = await handleRetryAndEscalation({
      task, initialError: 'error', projectDir: '/tmp/proj',
      config, context: defaultContext, planner, callbacks, currentState: state, implementer,
    });

    expect(result.completed).toBe(true);
    expect(result.method).toBe('escalated-hint');
    expect(planner.escalateHint).toHaveBeenCalled();
    expect(planner.escalateFull).not.toHaveBeenCalled();
  });

  it('full escalation: planner writes code that passes validation', async () => {
    const { callbacks } = makeCallbacks();
    const task = makeTask();
    const config = makeConfig({ workflow: { maxRetries: 1 } });
    const state = makeValidatingState();

    const implementer = makeImplementer({
      retry: vi.fn().mockResolvedValue({ success: false, output: '', error: 'fail', usage: { inputTokens: 10, outputTokens: 5 } }),
    });

    // retry always fails so validateTask is only called in tier2's validateAndCommit
    vi.mocked(validateTask).mockResolvedValueOnce(passingResults);

    const planner = makePlanner({
      escalateHint: vi.fn().mockResolvedValue({ success: true, output: 'hint', code: null, usage: { inputTokens: 50, outputTokens: 25 } }),
      escalateFull: vi.fn().mockResolvedValue({ success: true, output: 'full code', code: 'code', usage: { inputTokens: 200, outputTokens: 100 } }),
    });

    const result = await handleRetryAndEscalation({
      task, initialError: 'error', projectDir: '/tmp/proj',
      config, context: defaultContext, planner, callbacks, currentState: state, implementer,
    });

    expect(result.completed).toBe(true);
    expect(result.method).toBe('escalated-full');
    expect(planner.escalateFull).toHaveBeenCalled();
  });

  it('full escalation fails → task marked as failed, discardTaskChanges called', async () => {
    const { callbacks } = makeCallbacks();
    const task = makeTask();
    const config = makeConfig({ workflow: { maxRetries: 1 } });
    const state = makeValidatingState();

    const implementer = makeImplementer({
      retry: vi.fn().mockResolvedValue({ success: false, output: '', error: 'fail', usage: { inputTokens: 10, outputTokens: 5 } }),
    });
    vi.mocked(validateTask).mockResolvedValue(failingResults);

    const planner = makePlanner({
      escalateHint: vi.fn().mockResolvedValue({ success: true, output: 'hint', code: null, usage: null }),
      escalateFull: vi.fn().mockResolvedValue({ success: false, output: '', code: null, usage: null }),
    });

    const result = await handleRetryAndEscalation({
      task, initialError: 'error', projectDir: '/tmp/proj',
      config, context: defaultContext, planner, callbacks, currentState: state, implementer,
    });

    expect(result.completed).toBe(false);
    expect(result.method).toBe('failed');
    expect(discardTaskChanges).toHaveBeenCalled();
    expect(task.status).toBe('failed');
  });

  it('respects maxRetries config for local retry count', async () => {
    const { callbacks } = makeCallbacks();
    const task = makeTask();
    const config = makeConfig({ workflow: { maxRetries: 5 } });
    const state = makeValidatingState();

    const implementer = makeImplementer({
      retry: vi.fn().mockResolvedValue({ success: false, output: '', error: 'fail', usage: { inputTokens: 1, outputTokens: 1 } }),
    });
    vi.mocked(validateTask).mockResolvedValue(failingResults);

    const planner = makePlanner({
      escalateHint: vi.fn().mockResolvedValue({ success: true, output: 'hint', code: null, usage: null }),
      escalateFull: vi.fn().mockResolvedValue({ success: false, output: '', code: null, usage: null }),
    });

    await handleRetryAndEscalation({
      task, initialError: 'error', projectDir: '/tmp/proj',
      config, context: defaultContext, planner, callbacks, currentState: state, implementer,
    });

    // 5 local retries + 1 hint retry = 6 total retry calls
    expect(implementer.retry).toHaveBeenCalledTimes(6);
  });
});
