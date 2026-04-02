import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WorkflowState, OrchestratorCallbacks, ValidationResult } from '../../types.js';
import { makeUsage } from '#testing/helpers/fixtures.js';

vi.mock('../../state-persistence.js', () => ({
  appendEvent: vi.fn(),
}));

import { appendEvent } from '../../state-persistence.js';
import { emit, emitValidationStart, emitValidationResult, createTextHandler } from './events.js';

function makeState(overrides?: Partial<WorkflowState>): WorkflowState {
  return {
    stateVersion: 1,
    phase: 'implementing',
    feature: 'test',
    currentTaskIndex: 0,
    attempt: 0,
    tasks: [],
    completedTasks: [],
    escalatedTasks: [],
    skippedTasks: [],
    failedTasks: [],
    sessionId: null,
    startedAt: new Date().toISOString(),
    tokenUsage: makeUsage(),
    ...overrides,
  };
}

function makeCallbacks(overrides?: Partial<OrchestratorCallbacks>): OrchestratorCallbacks {
  return {
    onEvent: vi.fn(),
    onApprovalNeeded: vi.fn(),
    onExternalChanges: vi.fn(),
    onComplete: vi.fn(),
    ...overrides,
  };
}

describe('emit', () => {
  beforeEach(() => vi.clearAllMocks());

  it('calls appendEvent with correct event shape', () => {
    const state = makeState({ phase: 'implementing' });
    emit('/tmp/proj', state, 'task_started', 'T001', { foo: 'bar' });

    expect(appendEvent).toHaveBeenCalledOnce();
    const event = vi.mocked(appendEvent).mock.calls[0]![1];
    expect(event.type).toBe('task_started');
    expect(event.taskId).toBe('T001');
    expect(event.phase).toBe('implementing');
    expect(event.data).toEqual({ foo: 'bar' });
    expect(typeof event.ts).toBe('number');
  });

  it('works without optional taskId and data', () => {
    const state = makeState({ phase: 'researching' });
    emit('/tmp/proj', state, 'workflow_started');

    const event = vi.mocked(appendEvent).mock.calls[0]![1];
    expect(event.taskId).toBeUndefined();
    expect(event.data).toBeUndefined();
    expect(event.phase).toBe('researching');
  });
});

describe('emitValidationStart', () => {
  it('emits a validate event with running status', () => {
    const callbacks = makeCallbacks();
    emitValidationStart(callbacks);

    expect(callbacks.onEvent).toHaveBeenCalledOnce();
    const event = vi.mocked(callbacks.onEvent).mock.calls[0]![0];
    expect(event).toMatchObject({
      type: 'validate',
      status: 'running',
      passed: false,
      stages: { tsc: false, lint: false, test: false },
    });
  });
});

describe('emitValidationResult', () => {
  it('emits passed result when all validations pass', () => {
    const callbacks = makeCallbacks();
    const results: ValidationResult[] = [
      { stage: 'typecheck', passed: true },
      { stage: 'lint', passed: true },
      { stage: 'test', passed: true },
    ];
    emitValidationResult(callbacks, results, Date.now() - 100);

    const event = vi.mocked(callbacks.onEvent).mock.calls[0]![0];
    expect(event).toMatchObject({
      type: 'validate',
      status: 'done',
      passed: true,
      stages: { tsc: true, lint: true, test: true },
    });
    expect((event as any).error).toBeUndefined();
    expect(typeof (event as any).duration).toBe('number');
  });

  it('emits failed result with error when a stage fails', () => {
    const callbacks = makeCallbacks();
    const results: ValidationResult[] = [
      { stage: 'typecheck', passed: true },
      { stage: 'lint', passed: false, error: 'lint error' },
    ];
    emitValidationResult(callbacks, results, Date.now() - 50);

    const event = vi.mocked(callbacks.onEvent).mock.calls[0]![0] as any;
    expect(event.passed).toBe(false);
    expect(event.stages.tsc).toBe(true);
    expect(event.stages.lint).toBe(false);
    expect(event.error).toBe('lint error');
  });

  it('defaults missing stages to true', () => {
    const callbacks = makeCallbacks();
    const results: ValidationResult[] = [
      { stage: 'typecheck', passed: true },
    ];
    emitValidationResult(callbacks, results, Date.now());

    const event = vi.mocked(callbacks.onEvent).mock.calls[0]![0] as any;
    expect(event.stages.lint).toBe(true);
    expect(event.stages.test).toBe(true);
  });
});

describe('createTextHandler', () => {
  it('returns a function that emits planner-text events', () => {
    const callbacks = makeCallbacks();
    const handler = createTextHandler(callbacks);

    handler('hello world');

    expect(callbacks.onEvent).toHaveBeenCalledOnce();
    const event = vi.mocked(callbacks.onEvent).mock.calls[0]![0];
    expect(event).toMatchObject({
      type: 'planner-text',
      text: 'hello world',
    });
    expect(typeof (event as any).ts).toBe('number');
  });
});
