import { describe, it, expect } from 'vitest';
import { buildSummary } from './cost.js';
import type { BuildSummaryState } from './cost.js';
import { makeUsage, makeTask } from '#testing/helpers/fixtures.js';

function makeState(overrides?: Partial<BuildSummaryState>): BuildSummaryState {
  return {
    tasks: [makeTask({ id: 'T001' }), makeTask({ id: 'T002' }), makeTask({ id: 'T003' })],
    completedTasks: ['T001', 'T002', 'T003'],
    escalatedTasks: [],
    skippedTasks: [],
    failedTasks: [],
    tokenUsage: makeUsage(),
    ...overrides,
  };
}

describe('buildSummary', () => {
  it('all tasks completed locally → escalationRate 0', () => {
    const summary = buildSummary({
      feature: 'auth',
      state: makeState(),
      startTime: Date.now() - 5000,
      plannerTool: 'claude-code',
      implementerProvider: 'ollama',
    });

    expect(summary.totalTasks).toBe(3);
    expect(summary.completedByLocal).toBe(3);
    expect(summary.escalatedToPlanner).toBe(0);
    expect(summary.escalationRate).toBe(0);
    expect(summary.skipped).toBe(0);
    expect(summary.failed).toBe(0);
  });

  it('mix of local/escalated/skipped/failed → correct counts', () => {
    const state = makeState({
      tasks: [makeTask({ id: 'T001' }), makeTask({ id: 'T002' }), makeTask({ id: 'T003' }), makeTask({ id: 'T004' })],
      completedTasks: ['T001'],
      escalatedTasks: ['T002'],
      skippedTasks: ['T003'],
      failedTasks: ['T004'],
      tokenUsage: makeUsage({ plannerInput: 1000, implementerInput: 2000, escalationInput: 500 }),
    });

    const summary = buildSummary({
      feature: 'mixed',
      state,
      startTime: Date.now() - 10000,
    });

    expect(summary.totalTasks).toBe(4);
    expect(summary.completedByLocal).toBe(1);
    expect(summary.escalatedToPlanner).toBe(1);
    expect(summary.skipped).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.escalationRate).toBe(0.25);
  });

  it('zero tasks → no division by zero', () => {
    const state = makeState({
      tasks: [],
      completedTasks: [],
      escalatedTasks: [],
      skippedTasks: [],
      failedTasks: [],
    });

    const summary = buildSummary({
      feature: 'empty',
      state,
      startTime: Date.now(),
    });

    expect(summary.totalTasks).toBe(0);
    expect(summary.escalationRate).toBe(0);
    expect(Number.isFinite(summary.escalationRate)).toBe(true);
    expect(summary.costBreakdown).toBeDefined();
    expect(Number.isFinite(summary.costBreakdown!.savingsPercentage)).toBe(true);
  });

  it('token usage passed through correctly', () => {
    const usage = makeUsage({
      plannerInput: 100,
      plannerOutput: 200,
      implementerInput: 300,
      implementerOutput: 400,
      escalationInput: 50,
      escalationOutput: 60,
    });
    const state = makeState({ tokenUsage: usage });

    const summary = buildSummary({
      feature: 'tokens',
      state,
      startTime: Date.now() - 1000,
    });

    expect(summary.tokenUsage).toEqual(usage);
  });

  it('taskBreakdowns passed through to summary', () => {
    const breakdowns = [
      { taskId: 'T001', taskTitle: 'task 1', method: 'local' as const, implementerTokens: 100, escalationTokens: 0, retryCount: 0 },
    ];

    const summary = buildSummary({
      feature: 'with-breakdowns',
      state: makeState(),
      startTime: Date.now(),
      taskBreakdowns: breakdowns,
    });

    expect(summary.taskBreakdown).toEqual(breakdowns);
  });
});
