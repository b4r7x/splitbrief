import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { buildSummary, calculateTaskCost } from './summary.js';
import { calculateCostBreakdown } from '../providers/pricing.js';
import type { BuildSummaryState } from './summary.js';
import { taskId } from '../../core/schemas/task.js';
import { makeUsage } from '#testing/helpers/factories/summary.js';
import { makeTask } from '#testing/helpers/factories/task.js';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

function makeState(overrides?: Partial<BuildSummaryState>): BuildSummaryState {
  return {
    tasks: [
      makeTask({ id: 'T001', status: 'done' }),
      makeTask({ id: 'T002', status: 'done' }),
      makeTask({ id: 'T003', status: 'done' }),
    ],
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
      tasks: [
        makeTask({ id: 'T001', status: 'done' }),
        makeTask({ id: 'T002', status: 'escalated' }),
        makeTask({ id: 'T003', status: 'skipped' }),
        makeTask({ id: 'T004', status: 'failed' }),
      ],
      tokenUsage: makeUsage({ plannerInput: 1000, implementerInput: 2000, escalationInput: 500 }),
    });

    const summary = buildSummary({
      feature: 'mixed',
      state,
      startTime: Date.now() - 10000,
      plannerTool: 'claude-code',
      implementerTool: 'ollama',
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
    });

    const summary = buildSummary({
      feature: 'empty',
      state,
      startTime: Date.now(),
      plannerTool: 'claude-code',
      implementerTool: 'ollama',
    });

    expect(summary.totalTasks).toBe(0);
    expect(summary.escalationRate).toBe(0);
    expect(Number.isFinite(summary.escalationRate)).toBe(true);
    if (!summary.costBreakdown) throw new Error('expected costBreakdown on summary');
    expect(Number.isFinite(summary.costBreakdown.savingsPercentage)).toBe(true);
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
      plannerTool: 'claude-code',
      implementerTool: 'ollama',
    });

    expect(summary.tokenUsage).toEqual(usage);
  });

  it('taskBreakdowns passed through to summary', () => {
    const breakdowns = [
      { taskId: taskId('T001'), taskTitle: 'task 1', method: 'local' as const, implementerTokens: 100, escalationTokens: 0, retryCount: 0 },
    ];

    const summary = buildSummary({
      feature: 'with-breakdowns',
      state: makeState(),
      startTime: Date.now(),
      taskBreakdowns: breakdowns,
      plannerTool: 'claude-code',
      implementerTool: 'ollama',
    });

    expect(summary.taskBreakdown).toEqual([
      { taskId: taskId('T001'), taskTitle: 'task 1', method: 'local' as const, implementerTokens: 100, escalationTokens: 0, retryCount: 0, cost: 0 },
    ]);
    // Verify input array was NOT mutated
    expect(breakdowns[0]).not.toHaveProperty('cost');
  });

  it('includes model fields when provided', () => {
    const summary = buildSummary({
      feature: 'models',
      state: makeState(),
      startTime: Date.now() - 1000,
      plannerTool: 'openrouter',
      plannerModel: 'claude-sonnet-4-20250514',
      implementerTool: 'ollama',
      implementerModel: 'qwen2.5-coder:14b',
    });

    expect(summary.plannerModel).toBe('claude-sonnet-4-20250514');
    expect(summary.implementerModel).toBe('qwen2.5-coder:14b');
  });

  it('omits model fields when not provided', () => {
    const summary = buildSummary({
      feature: 'no-models',
      state: makeState(),
      startTime: Date.now(),
      plannerTool: 'claude-code',
      implementerTool: 'ollama',
    });

    expect(summary.plannerModel).toBeUndefined();
    expect(summary.implementerModel).toBeUndefined();
  });

  it('includes phaseTimings when provided', () => {
    const timings = { planning: 10_000, implementing: 50_000, review: 5_000 };
    const summary = buildSummary({
      feature: 'with-timings',
      state: makeState(),
      startTime: Date.now() - 65_000,
      plannerTool: 'claude-code',
      implementerTool: 'ollama',
      phaseTimings: timings,
    });

    expect(summary.phaseTimings).toEqual(timings);
  });

  it('omits phaseTimings when not provided', () => {
    const summary = buildSummary({
      feature: 'no-timings',
      state: makeState(),
      startTime: Date.now(),
      plannerTool: 'claude-code',
      implementerTool: 'ollama',
    });

    expect(summary.phaseTimings).toBeUndefined();
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
    const result = calculateCostBreakdown({
      tokenUsage: usage,
      totalTasks: 5,
      escalatedCount: 0,
      plannerTool: 'anthropic',
      plannerModel: 'claude-sonnet-4-6',
      implementerTool: 'ollama',
    });
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
    const result = calculateCostBreakdown({
      tokenUsage: usage,
      totalTasks: 3,
      escalatedCount: 3,
      plannerTool: 'anthropic',
      plannerModel: 'claude-sonnet-4-6',
      implementerTool: 'ollama',
    });
    expect(result.localCompletionRate).toBe(0);
  });

  it('mixed (5 local, 2 escalated out of 7) yields ~71.4% localCompletionRate', () => {
    const usage = makeUsage({
      implementerInput: 500_000,
      implementerOutput: 200_000,
      escalationInput: 100_000,
      escalationOutput: 50_000,
    });
    const result = calculateCostBreakdown({
      tokenUsage: usage,
      totalTasks: 7,
      escalatedCount: 2,
      plannerTool: 'anthropic',
      plannerModel: 'claude-sonnet-4-6',
      implementerTool: 'ollama',
    });
    expect(Math.abs(result.localCompletionRate - 0.7142857142857143)).toBeLessThan(0.001);
  });

  it('zero tasks yields 0% localCompletionRate without division by zero', () => {
    const usage = makeUsage();
    const result = calculateCostBreakdown({
      tokenUsage: usage,
      totalTasks: 0,
      escalatedCount: 0,
      plannerTool: 'anthropic',
      plannerModel: 'claude-sonnet-4-6',
      implementerTool: 'ollama',
    });
    expect(result.localCompletionRate).toBe(0);
    expect(result.savingsAmount).toBe(0);
    expect(Number.isFinite(result.savingsPercentage)).toBe(true);
  });

  it('planner spend does not reduce implementer savings', () => {
    const usage = makeUsage({
      plannerInput: 10_000_000,
      plannerOutput: 5_000_000,
      implementerInput: 100,
      implementerOutput: 50,
    });
    const result = calculateCostBreakdown({
      tokenUsage: usage,
      totalTasks: 1,
      escalatedCount: 0,
      plannerTool: 'anthropic',
      plannerModel: 'claude-sonnet-4-6',
      implementerTool: 'ollama',
    });
    expect(result.savingsAmount).toBeCloseTo(0.00105, 10);
    expect(result.savingsPercentage).toBeGreaterThan(0);
  });
});

describe('buildSummary estimatedCostSavings', () => {
  it('returns $0.00 when no implementer tokens used', () => {
    const usage = makeUsage({ plannerInput: 1000, plannerOutput: 500 });
    const summary = buildSummary({
      feature: 'f',
      state: makeState({ tasks: [], tokenUsage: usage }),
      startTime: Date.now(),
      plannerTool: 'anthropic',
      plannerModel: 'claude-sonnet-4-6',
      implementerTool: 'ollama',
    });
    expect(summary.estimatedCostSavings).toBe('$0.00');
  });

  it('calculates savings for known token values', () => {
    const usage = makeUsage({ implementerInput: 1_000_000, implementerOutput: 1_000_000 });
    const summary = buildSummary({
      feature: 'f',
      state: makeState({ tasks: [], tokenUsage: usage }),
      startTime: Date.now(),
      plannerTool: 'anthropic',
      plannerModel: 'claude-sonnet-4-6',
      implementerTool: 'ollama',
    });
    expect(summary.estimatedCostSavings).toBe('$18.00');
  });

  it('excludes planner spend from estimated savings', () => {
    const usage = makeUsage({
      plannerInput: 1_000_000,
      plannerOutput: 100_000,
      implementerInput: 2_000_000,
      implementerOutput: 500_000,
    });
    const summary = buildSummary({
      feature: 'f',
      state: makeState({ tasks: [], tokenUsage: usage }),
      startTime: Date.now(),
      plannerTool: 'anthropic',
      plannerModel: 'claude-sonnet-4-6',
      implementerTool: 'ollama',
    });
    expect(summary.estimatedCostSavings).toBe('$13.50');
  });

  it('returns $0.00 when savings would be negative', () => {
    const usage = makeUsage({
      plannerInput: 10_000_000,
      plannerOutput: 5_000_000,
      implementerInput: 100,
      implementerOutput: 50,
    });
    const summary = buildSummary({
      feature: 'f',
      state: makeState({ tasks: [], tokenUsage: usage }),
      startTime: Date.now(),
      plannerTool: 'anthropic',
      plannerModel: 'claude-sonnet-4-6',
      implementerTool: 'ollama',
    });
    expect(summary.estimatedCostSavings).toBe('$0.00');
  });
});

describe('calculateTaskCost', () => {
  it('returns 0 for local implementer with no escalation', () => {
    const task = { taskId: taskId('T001'), taskTitle: 'test', method: 'local' as const, implementerTokens: 1000, escalationTokens: 0, retryCount: 0 };
    const globalUsage = { implementerInput: 500, implementerOutput: 500, escalationInput: 0, escalationOutput: 0 };
    const cost = calculateTaskCost(task, globalUsage, 'ollama', 'claude-code');
    expect(cost).toBe(0);
  });

  it('calculates cost using blended rate from global token ratio', () => {
    const task = { taskId: taskId('T001'), taskTitle: 'test', method: 'local' as const, implementerTokens: 300_000, escalationTokens: 0, retryCount: 0 };
    const globalUsage = { implementerInput: 200_000, implementerOutput: 100_000, escalationInput: 0, escalationOutput: 0 };
    const cost = calculateTaskCost(task, globalUsage, 'deepseek', 'claude-code');
    expect(cost).toBeGreaterThan(0);
    expect(cost).toBeCloseTo(0.28 * 200_000 / 1_000_000 + 0.42 * 100_000 / 1_000_000, 6);
  });

  it('includes escalation cost when escalation tokens present', () => {
    const task = { taskId: taskId('T001'), taskTitle: 'test', method: 'escalated-full' as const, implementerTokens: 1000, escalationTokens: 150_000, retryCount: 2 };
    const globalUsage = { implementerInput: 500, implementerOutput: 500, escalationInput: 100_000, escalationOutput: 50_000 };
    const cost = calculateTaskCost(task, globalUsage, 'ollama', 'anthropic');
    expect(cost).toBeGreaterThan(0);
  });

  it('uses planner model pricing for per-task escalation attribution', () => {
    const task = { taskId: taskId('T001'), taskTitle: 'test', method: 'escalated-full' as const, implementerTokens: 0, escalationTokens: 150_000, retryCount: 1 };
    const globalUsage = { implementerInput: 0, implementerOutput: 0, escalationInput: 100_000, escalationOutput: 50_000 };

    const sonnetCost = calculateTaskCost(task, globalUsage, 'ollama', 'anthropic', undefined, 'claude-sonnet-4-6');
    const opusCost = calculateTaskCost(task, globalUsage, 'ollama', 'anthropic', undefined, 'claude-opus-4-6');

    expect(sonnetCost).toBeCloseTo(1.05, 6);
    expect(opusCost).toBeCloseTo(1.75, 6);
  });

  it('returns cost 0 when all global token totals are zero', () => {
    const task = { taskId: taskId('T001'), taskTitle: 'test', method: 'local' as const, implementerTokens: 0, escalationTokens: 0, retryCount: 0 };
    const globalUsage = { implementerInput: 0, implementerOutput: 0, escalationInput: 0, escalationOutput: 0 };
    const cost = calculateTaskCost(task, globalUsage, 'ollama', 'claude-code');
    expect(cost).toBe(0);
  });

  it('allocates cost uniformly across tasks regardless of individual token usage', () => {
    const globalUsage = { implementerInput: 600_000, implementerOutput: 400_000, escalationInput: 0, escalationOutput: 0 };
    const heavyTask = { taskId: taskId('T001'), taskTitle: 'heavy', method: 'local' as const, implementerTokens: 800_000, escalationTokens: 0, retryCount: 0 };
    const lightTask = { taskId: taskId('T002'), taskTitle: 'light', method: 'local' as const, implementerTokens: 200_000, escalationTokens: 0, retryCount: 0 };

    const heavyCost = calculateTaskCost(heavyTask, globalUsage, 'deepseek', 'claude-code');
    const lightCost = calculateTaskCost(lightTask, globalUsage, 'deepseek', 'claude-code');

    // Per-task cost uses blended rate × task tokens — tasks with more tokens cost proportionally more
    expect(heavyCost / lightCost).toBeCloseTo(800_000 / 200_000, 5);
    // Both use the same blended cost-per-token derived from global input/output ratio
    expect(heavyCost / 800_000).toBeCloseTo(lightCost / 200_000, 10);
  });
});

describe('buildSummary task costs', () => {
  it('populates cost on each task breakdown', () => {
    const usage = makeUsage({
      implementerInput: 200_000,
      implementerOutput: 100_000,
    });
    const breakdowns = [
      { taskId: taskId('T001'), taskTitle: 'task 1', method: 'local' as const, implementerTokens: 150_000, escalationTokens: 0, retryCount: 0 },
      { taskId: taskId('T002'), taskTitle: 'task 2', method: 'local' as const, implementerTokens: 150_000, escalationTokens: 0, retryCount: 0 },
    ];

    const summary = buildSummary({
      feature: 'with-costs',
      state: makeState({ tokenUsage: usage }),
      startTime: Date.now(),
      taskBreakdowns: breakdowns,
      plannerTool: 'claude-code',
      implementerTool: 'deepseek',
    });

    const breakdown = summary.taskBreakdown;
    if (!breakdown || breakdown.length < 2) throw new Error('expected 2 task breakdowns');
    const first = breakdown[0];
    const second = breakdown[1];
    if (!first || !second) throw new Error('expected 2 task breakdowns');
    if (first.cost === undefined || second.cost === undefined) throw new Error('expected cost on task breakdowns');
    if (!summary.costBreakdown) throw new Error('expected costBreakdown on summary');
    expect(first.cost + second.cost).toBeCloseTo(summary.costBreakdown.actualImplementerCost, 6);
  });

  it('task cost is 0 for local implementer', () => {
    const usage = makeUsage({ implementerInput: 100_000, implementerOutput: 50_000 });
    const breakdowns = [
      { taskId: taskId('T001'), taskTitle: 'task 1', method: 'local' as const, implementerTokens: 150_000, escalationTokens: 0, retryCount: 0 },
    ];

    const summary = buildSummary({
      feature: 'local-cost',
      state: makeState({ tokenUsage: usage }),
      startTime: Date.now(),
      taskBreakdowns: breakdowns,
      plannerTool: 'claude-code',
      implementerTool: 'ollama',
    });

    const first = summary.taskBreakdown?.[0];
    if (!first) throw new Error('expected a task breakdown entry');
    expect(first.cost).toBe(0);
  });

  it('keeps per-task escalation costs aligned with model-aware summary totals', () => {
    const usage = makeUsage({
      escalationInput: 100_000,
      escalationOutput: 50_000,
    });
    const breakdowns = [
      { taskId: taskId('T001'), taskTitle: 'task 1', method: 'escalated-full' as const, implementerTokens: 0, escalationTokens: 150_000, retryCount: 0 },
    ];

    const summary = buildSummary({
      feature: 'model-aware-costs',
      state: makeState({ tokenUsage: usage }),
      startTime: Date.now(),
      taskBreakdowns: breakdowns,
      plannerTool: 'anthropic',
      plannerModel: 'claude-opus-4-6',
      implementerTool: 'ollama',
    });

    const first = summary.taskBreakdown?.[0];
    if (!first || !summary.costBreakdown) throw new Error('expected task and cost breakdown');
    expect(first.cost).toBeCloseTo(summary.costBreakdown.actualPlannerCost, 6);
    expect(first.cost).toBeCloseTo(1.75, 6);
  });
});
