import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createInitialState } from '../../core/state/machine.js';
import type { WorkflowState } from '../../core/schemas/workflow.js';
import { makeBusRecorder } from '#testing/helpers/orchestrator-factories.js';
import { makeUsage } from '#testing/helpers/factories/summary.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { ensureSessionDir } from '../../core/paths-io.js';

import {
  publishPlannerStatus,
  publishValidation,
  publishError,
  publishCostPrediction,
  publishBudgetWarning,
  publishBudgetExceeded,
  publishGitCommit,
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

describe('publishPlannerStatus', () => {
  it('falls back to plannerTool / plannerModel from state when extra is not provided', () => {
    const { bus, events } = makeBusRecorder();
    const state = { ...createInitialState('test'), plannerTool: 'claude-code', plannerModel: 'opus-4' };

    publishPlannerStatus(bus, state, 'running');

    expect(events[0]).toMatchObject({ type: 'planner_status', status: 'running', tool: 'claude-code', model: 'opus-4' });
  });

  it('omits tool and model when neither state nor extra provides them', () => {
    const { bus, events } = makeBusRecorder();

    publishPlannerStatus(bus, createInitialState('test'), 'done');

    const e = events[0];
    if (!e) throw new Error('expected one planner_status event');
    expect(e).toMatchObject({ type: 'planner_status', status: 'done' });
    expect('tool' in e).toBe(false);
    expect('model' in e).toBe(false);
  });

  it('extra.tool / extra.model override state values', () => {
    const { bus, events } = makeBusRecorder();
    const state = { ...createInitialState('test'), plannerTool: 'claude-code', plannerModel: 'opus-4' };

    publishPlannerStatus(bus, state, 'done', { tool: 'agent-sdk', model: 'sonnet-4' });

    expect(events[0]).toMatchObject({ tool: 'agent-sdk', model: 'sonnet-4' });
  });
});

describe('publishValidation — result phase aggregates stage outcomes', () => {
  it('passed=true only when every stage passed', () => {
    const { bus, events } = makeBusRecorder();
    publishValidation(bus, 'implementing', 'T001' as import('../../core/schemas/task.js').TaskId, {
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
    const { bus, events } = makeBusRecorder();
    publishValidation(bus, 'implementing', 'T001' as import('../../core/schemas/task.js').TaskId, {
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
    const { bus, events } = makeBusRecorder();
    const startTime = Date.now() - 500;

    publishValidation(bus, 'implementing', 'T001' as import('../../core/schemas/task.js').TaskId, {
      phase: 'result', results: [{ stage: 'tsc', passed: true }], startTime,
    });

    expect((events[0] as Record<string, unknown>)['duration']).toBeGreaterThanOrEqual(400);
  });
});

describe('publish* payload forwarding', () => {
  it('publishError — forwards message and timestamp', () => {
    const { bus, events } = makeBusRecorder();
    publishError(bus, 'implementing', 'something went wrong');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'error', message: 'something went wrong' });
    expect((events[0] as { ts: number }).ts).toBeGreaterThan(0);
  });

  it('publishCostPrediction — forwards prediction payload', () => {
    const { bus, events } = makeBusRecorder();
    publishCostPrediction(bus, 'implementing', {
      estimatedTasks: 5,
      lowCost: 0.10,
      expectedCost: 0.25,
      highCost: 0.50,
      plannerTool: 'claude-code',
      implementerTool: 'ollama',
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'cost_prediction',
      prediction: {
        estimatedTasks: 5, lowCost: 0.10, expectedCost: 0.25, highCost: 0.50,
        plannerTool: 'claude-code', implementerTool: 'ollama',
      },
    });
  });

  it('publishBudgetWarning — forwards cost and budget', () => {
    const { bus, events } = makeBusRecorder();
    publishBudgetWarning(bus, 'implementing', 0.80, 1.00);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'budget_warning', currentCost: 0.80, maxBudget: 1.00 });
  });

  it('publishBudgetExceeded — forwards cost and budget', () => {
    const { bus, events } = makeBusRecorder();
    publishBudgetExceeded(bus, 'implementing', 1.50, 1.00);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'budget_exceeded', currentCost: 1.50, maxBudget: 1.00 });
  });

  it('publishGitCommit — includes file when provided', () => {
    const { bus, events } = makeBusRecorder();
    publishGitCommit(bus, 'implementing', 'T1' as import('../../core/schemas/task.js').TaskId, 'chore: commit', 'src/a.ts');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'git_commit', message: 'chore: commit', file: 'src/a.ts' });
  });

  it('publishGitCommit — omits file when not provided', () => {
    const { bus, events } = makeBusRecorder();
    publishGitCommit(bus, 'implementing', 'T1' as import('../../core/schemas/task.js').TaskId, 'chore: commit');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'git_commit', message: 'chore: commit' });
    expect('file' in (events[0] as Record<string, unknown>)).toBe(false);
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
    const { bus, events } = makeBusRecorder();

    const result = addUsageAndSave(projectDir, sessionId, state, 'planner', {
      inputTokens: 200,
      outputTokens: 100,
    }, bus);

    expect(result.tokenUsage.plannerInput).toBe(300);
    expect(result.tokenUsage.plannerOutput).toBe(150);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'cost_update' });
  });

  it('returns the same state instance and emits nothing when usage is null', () => {
    const { projectDir, sessionId } = setupProject();
    const state = makeState();
    const { bus, events } = makeBusRecorder();

    const result = addUsageAndSave(projectDir, sessionId, state, 'implementer', null, bus);

    expect(result).toBe(state);
    expect(events).toHaveLength(0);
  });
});
