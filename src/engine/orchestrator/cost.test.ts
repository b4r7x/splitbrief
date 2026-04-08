import { describe, it, expect } from 'vitest';
import { buildSummary, calculateCostBreakdown, estimateCostSavings } from './cost.js';
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
      implementerTool: 'ollama',
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

describe('calculateCostBreakdown', () => {
  it('all local (0 escalations) yields 100% localCompletionRate and positive savings', () => {
    const usage = makeUsage({
      plannerInput: 100_000,
      plannerOutput: 50_000,
      implementerInput: 1_000_000,
      implementerOutput: 500_000,
    });
    const result = calculateCostBreakdown({ tokenUsage: usage, totalTasks: 5, escalatedCount: 0, plannerTool: 'claude-code', implementerTool: 'ollama' });
    expect(result.localCompletionRate).toBe(1);
    expect(result.savingsPercentage).toBeGreaterThan(0);
  });

  it('all escalated yields 0% localCompletionRate', () => {
    const usage = makeUsage({
      plannerInput: 500_000,
      plannerOutput: 200_000,
      escalationInput: 1_000_000,
      escalationOutput: 500_000,
    });
    const result = calculateCostBreakdown({ tokenUsage: usage, totalTasks: 3, escalatedCount: 3, plannerTool: 'claude-code', implementerTool: 'ollama' });
    expect(result.localCompletionRate).toBe(0);
  });

  it('mixed (5 local, 2 escalated out of 7) yields ~71.4% localCompletionRate', () => {
    const usage = makeUsage({
      implementerInput: 500_000,
      implementerOutput: 200_000,
      escalationInput: 100_000,
      escalationOutput: 50_000,
    });
    const result = calculateCostBreakdown({ tokenUsage: usage, totalTasks: 7, escalatedCount: 2, plannerTool: 'claude-code', implementerTool: 'ollama' });
    expect(Math.abs(result.localCompletionRate - 0.7142857142857143)).toBeLessThan(0.001);
  });

  it('zero tasks yields 0% localCompletionRate without division by zero', () => {
    const usage = makeUsage();
    const result = calculateCostBreakdown({ tokenUsage: usage, totalTasks: 0, escalatedCount: 0, plannerTool: 'claude-code', implementerTool: 'ollama' });
    expect(result.localCompletionRate).toBe(0);
    expect(result.savingsAmount).toBe(0);
    expect(Number.isFinite(result.savingsPercentage)).toBe(true);
  });

  it('negative savings clamped to 0', () => {
    const usage = makeUsage({
      plannerInput: 10_000_000,
      plannerOutput: 5_000_000,
      implementerInput: 100,
      implementerOutput: 50,
    });
    const result = calculateCostBreakdown({ tokenUsage: usage, totalTasks: 1, escalatedCount: 0, plannerTool: 'claude-code', implementerTool: 'ollama' });
    expect(result.savingsAmount).toBe(0);
    expect(result.savingsPercentage).toBe(0);
  });
});

describe('estimateCostSavings', () => {
  it('returns $0.00 when no implementer tokens used', () => {
    const usage = makeUsage({ plannerInput: 1000, plannerOutput: 500 });
    expect(estimateCostSavings(usage, 'claude-code', 'ollama')).toBe('$0.00');
  });

  it('calculates savings for known token values', () => {
    const usage = makeUsage({ implementerInput: 1_000_000, implementerOutput: 1_000_000 });
    expect(estimateCostSavings(usage, 'claude-code', 'ollama')).toBe('$30.00');
  });

  it('subtracts actual Opus cost from hypothetical', () => {
    const usage = makeUsage({
      plannerInput: 1_000_000,
      plannerOutput: 100_000,
      implementerInput: 2_000_000,
      implementerOutput: 500_000,
    });
    expect(estimateCostSavings(usage, 'claude-code', 'ollama')).toBe('$15.00');
  });

  it('returns $0.00 when savings would be negative', () => {
    const usage = makeUsage({
      plannerInput: 10_000_000,
      plannerOutput: 5_000_000,
      implementerInput: 100,
      implementerOutput: 50,
    });
    expect(estimateCostSavings(usage, 'claude-code', 'ollama')).toBe('$0.00');
  });
});
