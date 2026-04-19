import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createInitialState } from '../../core/state/machine.js';
import type { WorkflowState } from '../../core/schemas/workflow.js';
import type { TuiEvent } from '../../features/workflow/types.js';
import type { OrchestratorCallbacks } from './types.js';
import { makeCallbacks } from '#testing/helpers/orchestrator-factories.js';
import { makeUsage } from '#testing/helpers/factories/summary.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { ensureSessionDir } from '../../core/paths-io.js';

import {
  emitPlannerStatus,
  emitValidation,
  emitError,
  emitCostPrediction,
  emitBudgetWarning,
  emitBudgetExceeded,
} from './events.js';
import { addUsageAndSave } from './state-ops.js';

let dirs: string[] = [];

afterEach(() => {
  for (const d of dirs) cleanupTempDir(d);
  dirs = [];
});

function setupProject(): { projectDir: string; sessionId: string } {
  const projectDir = createTempDir('emit-test');
  dirs.push(projectDir);
  const sessionId = 'sess-emit';
  ensureSessionDir(projectDir, sessionId);
  return { projectDir, sessionId };
}

describe('emitPlannerStatus', () => {
  it('falls back to plannerTool / plannerModel from state when extra is not provided', () => {
    const { callbacks, events } = makeCallbacks();
    const state = { ...createInitialState('test'), plannerTool: 'claude-code', plannerModel: 'opus-4' };

    emitPlannerStatus(callbacks, state, 'running');

    expect(events[0]).toMatchObject({ type: 'planner-status', status: 'running', tool: 'claude-code', model: 'opus-4' });
  });

  it('omits tool and model when neither state nor extra provides them', () => {
    const { callbacks, events } = makeCallbacks();

    emitPlannerStatus(callbacks, createInitialState('test'), 'done');

    const e = events[0];
    if (!e) throw new Error('expected one planner-status event');
    expect(e).toMatchObject({ type: 'planner-status', status: 'done' });
    expect('tool' in e).toBe(false);
    expect('model' in e).toBe(false);
  });

  it('extra.tool / extra.model override state values', () => {
    const { callbacks, events } = makeCallbacks();
    const state = { ...createInitialState('test'), plannerTool: 'claude-code', plannerModel: 'opus-4' };

    emitPlannerStatus(callbacks, state, 'done', { tool: 'agent-sdk', model: 'sonnet-4' });

    expect(events[0]).toMatchObject({ tool: 'agent-sdk', model: 'sonnet-4' });
  });
});

describe('emitValidation — result phase aggregates stage outcomes', () => {
  it('passed=true only when every stage passed', () => {
    const { callbacks, events } = makeCallbacks();
    emitValidation(callbacks, {
      phase: 'result',
      results: [
        { stage: 'tsc', passed: true },
        { stage: 'lint', passed: true },
        { stage: 'test', passed: true },
      ],
      startTime: Date.now() - 100,
    });

    expect(events[0]).toMatchObject({
      type: 'validate', status: 'done', passed: true,
      stages: { tsc: true, lint: true, test: true },
    });
    expect((events[0] as Record<string, unknown>)['error']).toBeUndefined();
  });

  it('passed=false with first failing stage error on partial failure', () => {
    const { callbacks, events } = makeCallbacks();
    emitValidation(callbacks, {
      phase: 'result',
      results: [
        { stage: 'tsc', passed: true },
        { stage: 'lint', passed: false, error: 'lint error' },
      ],
      startTime: Date.now(),
    });

    expect(events[0]).toMatchObject({
      type: 'validate', passed: false,
      stages: { tsc: true, lint: false, test: false },
      error: 'lint error',
    });
  });

  it('duration is measured from startTime', () => {
    const { callbacks, events } = makeCallbacks();
    const startTime = Date.now() - 500;

    emitValidation(callbacks, { phase: 'result', results: [{ stage: 'tsc', passed: true }], startTime });

    expect((events[0] as Record<string, unknown>)['duration']).toBeGreaterThanOrEqual(400);
  });
});

type EmitCase = {
  name: string;
  invoke: (cb: OrchestratorCallbacks) => void;
  expected: Partial<TuiEvent> & { type: TuiEvent['type'] };
};

const EMIT_CASES: EmitCase[] = [
  {
    name: 'emitError — forwards message and timestamp',
    invoke: (cb) => emitError(cb, 'something went wrong'),
    expected: { type: 'error', message: 'something went wrong' },
  },
  {
    name: 'emitCostPrediction — forwards prediction payload',
    invoke: (cb) => emitCostPrediction(cb, {
      estimatedTasks: 5,
      lowCost: 0.10,
      expectedCost: 0.25,
      highCost: 0.50,
      plannerTool: 'claude-code',
      implementerTool: 'ollama',
    }),
    expected: {
      type: 'cost-prediction',
      prediction: {
        estimatedTasks: 5, lowCost: 0.10, expectedCost: 0.25, highCost: 0.50,
        plannerTool: 'claude-code', implementerTool: 'ollama',
      },
    } as Partial<TuiEvent> & { type: 'cost-prediction' },
  },
  {
    name: 'emitBudgetWarning — forwards cost and budget',
    invoke: (cb) => emitBudgetWarning(cb, 0.80, 1.00),
    expected: { type: 'budget-warning', currentCost: 0.80, maxBudget: 1.00 } as Partial<TuiEvent> & { type: 'budget-warning' },
  },
  {
    name: 'emitBudgetExceeded — forwards cost and budget',
    invoke: (cb) => emitBudgetExceeded(cb, 1.50, 1.00),
    expected: { type: 'budget-exceeded', currentCost: 1.50, maxBudget: 1.00 } as Partial<TuiEvent> & { type: 'budget-exceeded' },
  },
];

describe('emit* payload forwarding', () => {
  it.each(EMIT_CASES)('$name', ({ invoke, expected }) => {
    const { callbacks, events } = makeCallbacks();
    invoke(callbacks);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject(expected);
    expect((events[0] as { ts: number }).ts).toBeGreaterThan(0);
  });
});

function makeState(overrides?: Partial<WorkflowState>): WorkflowState {
  return {
    stateVersion: 1,
    phase: 'implementing',
    feature: 'test',
    currentTaskIndex: 0,
    attempt: 0,
    tasks: [],
    plannerSessionId: null,
    startedAt: new Date().toISOString(),
    tokenUsage: makeUsage(),
    awaitingContinue: false,
    messageQueue: [],
    ...overrides,
  };
}

describe('addUsageAndSave', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('accumulates token usage into the new state and emits a cost-update event', () => {
    const { projectDir, sessionId } = setupProject();
    const state = makeState({ tokenUsage: makeUsage({ plannerInput: 100, plannerOutput: 50 }) });
    const { callbacks, events } = makeCallbacks();

    const result = addUsageAndSave(projectDir, sessionId, state, 'planner', {
      inputTokens: 200,
      outputTokens: 100,
    }, callbacks);

    expect(result.tokenUsage.plannerInput).toBe(300);
    expect(result.tokenUsage.plannerOutput).toBe(150);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'cost-update' });
  });

  it('returns the same state instance and emits nothing when usage is null', () => {
    const { projectDir, sessionId } = setupProject();
    const state = makeState();
    const { callbacks, events } = makeCallbacks();

    const result = addUsageAndSave(projectDir, sessionId, state, 'implementer', null, callbacks);

    expect(result).toBe(state);
    expect(events).toHaveLength(0);
  });
});
