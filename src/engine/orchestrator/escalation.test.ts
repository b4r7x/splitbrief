import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WorkflowState } from '../../core/types/state-actions.js';
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
vi.mock('../../lib/git.js', () => ({
  commitChanges: vi.fn(),
}));
vi.mock('../../core/state/persistence.js', () => ({
  saveState: vi.fn(),
  appendEvent: vi.fn(),
}));
vi.mock('../runners/factory.js', () => ({
  createImplementer: vi.fn(),
}));
vi.mock('./task-commit.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./task-commit.js')>();
  return { ...mod, validateCommitAndAdvance: vi.fn(mod.validateCommitAndAdvance) };
});

import { handleRetryAndEscalation } from './escalation.js';
import { runValidationWithEvents } from './validator.js';
import { discardTaskChanges } from './git-ops.js';
import { createImplementer } from '../runners/factory.js';
import { validateCommitAndAdvance } from './task-commit.js';
import type { WorkflowSinks } from './types.js';

const TEST_METADATA = { plannerTool: 'claude-code', implementerTool: 'ollama', mode: 'standard' };

const TEST_SINKS: WorkflowSinks = {
  setAbortHandler: () => {},
  setQueueHandler: () => {},
};

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
      wctx: { projectDir: '/tmp/proj', config, context: defaultContext, planner, callbacks, implementer, metadata: TEST_METADATA, sessionId: 'test-session', sinks: TEST_SINKS },
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
      wctx: { projectDir: '/tmp/proj', config, context: defaultContext, planner, callbacks, implementer, metadata: TEST_METADATA, sessionId: 'test-session', sinks: TEST_SINKS },
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
      wctx: { projectDir: '/tmp/proj', config, context: defaultContext, planner, callbacks, implementer, metadata: TEST_METADATA, sessionId: 'test-session', sinks: TEST_SINKS },
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
      wctx: { projectDir: '/tmp/proj', config, context: defaultContext, planner, callbacks, implementer, metadata: TEST_METADATA, sessionId: 'test-session', sinks: TEST_SINKS },
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
      wctx: { projectDir: '/tmp/proj', config, context: defaultContext, planner, callbacks, implementer, metadata: TEST_METADATA, sessionId: 'test-session', sinks: TEST_SINKS },
      task, initialError: 'error', currentState: state,
    });

    expect(result.completed).toBe(false);
    expect(result.method).toBe('failed');
    expect(discardTaskChanges).toHaveBeenCalled();
  });

  describe('intermediate escalation (Tier 0)', () => {
    it('intermediate provider configured and succeeds → no further escalation', async () => {
      const { callbacks } = makeCallbacks();
      const task = makeTask();
      const config = makeConfig({
        workflow: { maxRetries: 1 },
        escalation: { intermediateProvider: 'deepseek', intermediateModel: 'deepseek-coder', enabled: true },
      });
      const state = makeValidatingState();

      const implementer = makeImplementer({
        retry: vi.fn().mockResolvedValue({ success: false, output: '', error: 'fail', usage: { inputTokens: 10, outputTokens: 5 } }),
      });

      const intermediateImplementer = makeImplementer({
        retry: vi.fn().mockResolvedValue({ success: true, output: 'fixed', usage: { inputTokens: 30, outputTokens: 15 } }),
      });
      vi.mocked(createImplementer).mockReturnValue(intermediateImplementer);

      vi.mocked(runValidationWithEvents).mockResolvedValue(passingResults);

      const planner = makePlanner();

      const { result } = await handleRetryAndEscalation({
        wctx: { projectDir: '/tmp/proj', config, context: defaultContext, planner, callbacks, implementer, metadata: TEST_METADATA, sessionId: 'test-session', sinks: TEST_SINKS },
        task, initialError: 'error', currentState: state,
      });

      expect(result.completed).toBe(true);
      expect(result.method).toBe('escalated-intermediate');
      expect(planner.escalateHint).not.toHaveBeenCalled();
      expect(planner.escalateFull).not.toHaveBeenCalled();
    });

    it('intermediate provider configured and fails → falls through to Tier 1', async () => {
      const { callbacks } = makeCallbacks();
      const task = makeTask();
      const config = makeConfig({
        workflow: { maxRetries: 1 },
        escalation: { intermediateProvider: 'deepseek', intermediateModel: 'deepseek-coder', enabled: true },
      });
      const state = makeValidatingState();

      const implementer = makeImplementer({
        retry: vi.fn().mockResolvedValue({ success: false, output: '', error: 'fail', usage: { inputTokens: 10, outputTokens: 5 } }),
      });

      const intermediateImplementer = makeImplementer({
        retry: vi.fn().mockResolvedValue({ success: false, output: '', error: 'intermediate fail', usage: { inputTokens: 30, outputTokens: 15 } }),
      });
      vi.mocked(createImplementer).mockReturnValue(intermediateImplementer);

      vi.mocked(runValidationWithEvents).mockResolvedValue(failingResults);

      const planner = makePlanner({
        escalateHint: vi.fn().mockResolvedValue({ success: true, output: 'hint', code: null, usage: null }),
        escalateFull: vi.fn().mockResolvedValue({ success: false, output: '', code: null, usage: null }),
      });

      const { result } = await handleRetryAndEscalation({
        wctx: { projectDir: '/tmp/proj', config, context: defaultContext, planner, callbacks, implementer, metadata: TEST_METADATA, sessionId: 'test-session', sinks: TEST_SINKS },
        task, initialError: 'error', currentState: state,
      });

      expect(planner.escalateHint).toHaveBeenCalled();
      expect(result.completed).toBe(false);
    });

    it('intermediate provider not configured → behaves exactly as before', async () => {
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
        wctx: { projectDir: '/tmp/proj', config, context: defaultContext, planner, callbacks, implementer, metadata: TEST_METADATA, sessionId: 'test-session', sinks: TEST_SINKS },
        task, initialError: 'error', currentState: state,
      });

      expect(createImplementer).not.toHaveBeenCalled();
      expect(planner.escalateHint).toHaveBeenCalled();
      expect(result.completed).toBe(false);
    });

    it('escalation.enabled is false → skips intermediate, goes to Tier 1', async () => {
      const { callbacks } = makeCallbacks();
      const task = makeTask();
      const config = makeConfig({
        workflow: { maxRetries: 1 },
        escalation: { intermediateProvider: 'deepseek', intermediateModel: 'deepseek-coder', enabled: false },
      });
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
        wctx: { projectDir: '/tmp/proj', config, context: defaultContext, planner, callbacks, implementer, metadata: TEST_METADATA, sessionId: 'test-session', sinks: TEST_SINKS },
        task, initialError: 'error', currentState: state,
      });

      expect(createImplementer).not.toHaveBeenCalled();
      expect(planner.escalateHint).toHaveBeenCalled();
      expect(result.completed).toBe(false);
    });

    it('intermediate provider creation fails → skips to Tier 1 gracefully', async () => {
      const { callbacks } = makeCallbacks();
      const task = makeTask();
      const config = makeConfig({
        workflow: { maxRetries: 1 },
        escalation: { intermediateProvider: 'unknown-provider', intermediateModel: 'some-model', enabled: true },
      });
      const state = makeValidatingState();

      const implementer = makeImplementer({
        retry: vi.fn().mockResolvedValue({ success: false, output: '', error: 'fail', usage: { inputTokens: 10, outputTokens: 5 } }),
      });
      vi.mocked(createImplementer).mockImplementation(() => { throw new Error('Unknown provider'); });

      vi.mocked(runValidationWithEvents).mockResolvedValue(failingResults);

      const planner = makePlanner({
        escalateHint: vi.fn().mockResolvedValue({ success: true, output: 'hint', code: null, usage: null }),
        escalateFull: vi.fn().mockResolvedValue({ success: false, output: '', code: null, usage: null }),
      });

      const { result } = await handleRetryAndEscalation({
        wctx: { projectDir: '/tmp/proj', config, context: defaultContext, planner, callbacks, implementer, metadata: TEST_METADATA, sessionId: 'test-session', sinks: TEST_SINKS },
        task, initialError: 'error', currentState: state,
      });

      expect(planner.escalateHint).toHaveBeenCalled();
      expect(result.completed).toBe(false);
    });

    it('intermediate succeeds but validation fails → falls through to Tier 1', async () => {
      const { callbacks } = makeCallbacks();
      const task = makeTask();
      const config = makeConfig({
        workflow: { maxRetries: 1 },
        escalation: { intermediateProvider: 'deepseek', intermediateModel: 'deepseek-coder', enabled: true },
      });
      const state = makeValidatingState();

      const implementer = makeImplementer({
        retry: vi.fn().mockResolvedValue({ success: false, output: '', error: 'fail', usage: { inputTokens: 10, outputTokens: 5 } }),
      });

      const intermediateImplementer = makeImplementer({
        retry: vi.fn().mockResolvedValue({ success: true, output: 'fixed', usage: { inputTokens: 30, outputTokens: 15 } }),
      });
      vi.mocked(createImplementer).mockReturnValue(intermediateImplementer);

      vi.mocked(runValidationWithEvents).mockResolvedValue(failingResults);

      const planner = makePlanner({
        escalateHint: vi.fn().mockResolvedValue({ success: true, output: 'hint', code: null, usage: null }),
        escalateFull: vi.fn().mockResolvedValue({ success: false, output: '', code: null, usage: null }),
      });

      const { result } = await handleRetryAndEscalation({
        wctx: { projectDir: '/tmp/proj', config, context: defaultContext, planner, callbacks, implementer, metadata: TEST_METADATA, sessionId: 'test-session', sinks: TEST_SINKS },
        task, initialError: 'error', currentState: state,
      });

      expect(planner.escalateHint).toHaveBeenCalled();
      expect(result.completed).toBe(false);
    });

    it('tier 0 validation failure propagates commitResult.state, not stale local state', async () => {
      const { callbacks } = makeCallbacks();
      const task = makeTask();
      const config = makeConfig({
        workflow: { maxRetries: 1 },
        escalation: { intermediateProvider: 'deepseek', intermediateModel: 'deepseek-coder', enabled: true },
      });
      const state = makeValidatingState();

      const implementer = makeImplementer({
        retry: vi.fn().mockResolvedValue({ success: false, output: '', error: 'fail', usage: { inputTokens: 10, outputTokens: 5 } }),
      });

      const intermediateImplementer = makeImplementer({
        retry: vi.fn().mockResolvedValue({ success: true, output: 'fixed', usage: { inputTokens: 30, outputTokens: 15 } }),
      });
      vi.mocked(createImplementer).mockReturnValue(intermediateImplementer);

      // Override validateCommitAndAdvance to return a state with a marker value
      // proving the returned state comes from commitResult, not the local variable
      const MARKER = 777;
      vi.mocked(validateCommitAndAdvance).mockImplementationOnce(async (opts) => ({
        state: { ...opts.state, tokenUsage: { ...opts.state.tokenUsage, escalationInput: MARKER } },
        completed: false,
      }));
      vi.mocked(runValidationWithEvents).mockResolvedValue(failingResults);

      // Tier 1 implementer retry fails → no validation call
      // Tier 2 escalateFull fails → no validation call
      const planner = makePlanner({
        escalateHint: vi.fn().mockResolvedValue({ success: true, output: 'hint', code: null, usage: null }),
        escalateFull: vi.fn().mockResolvedValue({ success: false, output: '', code: null, usage: null }),
      });

      const { state: finalState } = await handleRetryAndEscalation({
        wctx: { projectDir: '/proj', config, context: defaultContext, planner, callbacks, implementer, metadata: TEST_METADATA, sessionId: 'test-session', sinks: TEST_SINKS },
        task, initialError: 'error', currentState: state,
      });

      // The marker value should propagate through subsequent tiers.
      // With the bug (returning local `state`), escalationInput would be 30 (from addUsageAndSave).
      // With the fix (returning commitResult.state), escalationInput starts at MARKER (777).
      expect(finalState.tokenUsage.escalationInput).toBeGreaterThanOrEqual(MARKER);
    });

    it('emits escalate event with tier 0 for intermediate', async () => {
      const { callbacks, events } = makeCallbacks();
      const task = makeTask();
      const config = makeConfig({
        workflow: { maxRetries: 1 },
        escalation: { intermediateProvider: 'deepseek', intermediateModel: 'deepseek-coder', enabled: true },
      });
      const state = makeValidatingState();

      const implementer = makeImplementer({
        retry: vi.fn().mockResolvedValue({ success: false, output: '', error: 'fail', usage: { inputTokens: 10, outputTokens: 5 } }),
      });

      const intermediateImplementer = makeImplementer({
        retry: vi.fn().mockResolvedValue({ success: true, output: 'fixed', usage: { inputTokens: 30, outputTokens: 15 } }),
      });
      vi.mocked(createImplementer).mockReturnValue(intermediateImplementer);
      vi.mocked(runValidationWithEvents).mockResolvedValue(passingResults);

      const planner = makePlanner();

      await handleRetryAndEscalation({
        wctx: { projectDir: '/tmp/proj', config, context: defaultContext, planner, callbacks, implementer, metadata: TEST_METADATA, sessionId: 'test-session', sinks: TEST_SINKS },
        task, initialError: 'error', currentState: state,
      });

      const escalateEvents = events.filter(e => e.type === 'escalate');
      expect(escalateEvents).toHaveLength(1);
      expect(escalateEvents[0]).toMatchObject({ type: 'escalate', tier: 0 });
    });

    it('records intermediate tokens as implementer category, not escalation', async () => {
      const { callbacks } = makeCallbacks();
      const task = makeTask();
      const config = makeConfig({
        workflow: { maxRetries: 1 },
        escalation: { intermediateProvider: 'deepseek', intermediateModel: 'deepseek-coder', enabled: true },
      });
      const state = makeValidatingState();

      const implementer = makeImplementer({
        retry: vi.fn().mockResolvedValue({ success: false, output: '', error: 'fail', usage: { inputTokens: 10, outputTokens: 5 } }),
      });

      const intermediateImplementer = makeImplementer({
        retry: vi.fn().mockResolvedValue({ success: true, output: 'fixed', usage: { inputTokens: 300, outputTokens: 150 } }),
      });
      vi.mocked(createImplementer).mockReturnValue(intermediateImplementer);
      vi.mocked(runValidationWithEvents).mockResolvedValue(passingResults);

      const planner = makePlanner();

      const { state: finalState } = await handleRetryAndEscalation({
        wctx: { projectDir: '/tmp/proj', config, context: defaultContext, planner, callbacks, implementer, metadata: TEST_METADATA, sessionId: 'test-session', sinks: TEST_SINKS },
        task, initialError: 'error', currentState: state,
      });

      // Intermediate tokens should be under implementer, not escalation
      expect(finalState.tokenUsage.implementerInput).toBeGreaterThanOrEqual(300);
      expect(finalState.tokenUsage.escalationInput).toBe(0);
    });
  });

});
