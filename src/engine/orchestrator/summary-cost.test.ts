import { describe, it, expect } from 'vitest';
import { calculateCostBreakdown, calculateTaskUsageCost } from '../providers/cost.js';
import { taskId } from '../../core/schemas/task.js';
import { makeUsage } from '#testing/helpers/factories/summary.js';

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
      implementerTool: 'deepseek',
      implementerModel: 'deepseek-chat',
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
      implementerTool: 'deepseek',
      implementerModel: 'deepseek-chat',
    });
    expect(result.savingsAmount).toBeCloseTo(0.001001, 10);
    expect(result.savingsPercentage).toBeGreaterThan(0);
  });
});

describe('calculateTaskUsageCost', () => {
  it('returns 0 for local implementer with no escalation', () => {
    const task = {
      taskId: taskId('T001'),
      taskTitle: 'test',
      method: 'local' as const,
      implementerTokens: 1000,
      escalationTokens: 0,
      retryCount: 0,
    };
    const globalUsage = {
      implementerInput: 500,
      implementerOutput: 500,
      escalationInput: 0,
      escalationOutput: 0,
    };
    const cost = calculateTaskUsageCost({
      task: task,
      tokenUsage: globalUsage,
      implementerTool: 'ollama',
      plannerTool: 'claude-code',
    });
    expect(cost).toBe(0);
  });

  it('calculates cost using blended rate from global token ratio', () => {
    const task = {
      taskId: taskId('T001'),
      taskTitle: 'test',
      method: 'local' as const,
      implementerTokens: 300_000,
      escalationTokens: 0,
      retryCount: 0,
    };
    const globalUsage = {
      implementerInput: 200_000,
      implementerOutput: 100_000,
      escalationInput: 0,
      escalationOutput: 0,
    };
    const cost = calculateTaskUsageCost({
      task: task,
      tokenUsage: globalUsage,
      implementerTool: 'deepseek',
      plannerTool: 'claude-code',
    });
    expect(cost).toBeGreaterThan(0);
    expect(cost).toBeCloseTo((0.28 * 200_000) / 1_000_000 + (0.42 * 100_000) / 1_000_000, 6);
  });

  it('includes escalation cost when escalation tokens present', () => {
    const task = {
      taskId: taskId('T001'),
      taskTitle: 'test',
      method: 'escalated-full' as const,
      implementerTokens: 1000,
      escalationTokens: 150_000,
      retryCount: 2,
    };
    const globalUsage = {
      implementerInput: 500,
      implementerOutput: 500,
      escalationInput: 100_000,
      escalationOutput: 50_000,
    };
    const cost = calculateTaskUsageCost({
      task: task,
      tokenUsage: globalUsage,
      implementerTool: 'ollama',
      plannerTool: 'anthropic',
    });
    expect(cost).toBeGreaterThan(0);
  });

  it('uses planner model pricing for per-task escalation attribution', () => {
    const task = {
      taskId: taskId('T001'),
      taskTitle: 'test',
      method: 'escalated-full' as const,
      implementerTokens: 0,
      escalationTokens: 150_000,
      retryCount: 1,
    };
    const globalUsage = {
      implementerInput: 0,
      implementerOutput: 0,
      escalationInput: 100_000,
      escalationOutput: 50_000,
    };

    const sonnetCost = calculateTaskUsageCost({
      task: task,
      tokenUsage: globalUsage,
      implementerTool: 'ollama',
      plannerTool: 'anthropic',
      plannerModel: 'claude-sonnet-4-6',
    });
    const opusCost = calculateTaskUsageCost({
      task: task,
      tokenUsage: globalUsage,
      implementerTool: 'ollama',
      plannerTool: 'anthropic',
      plannerModel: 'claude-opus-4-6',
    });

    expect(sonnetCost).toBeCloseTo(1.05, 6);
    expect(opusCost).toBeCloseTo(1.75, 6);
  });

  it('returns cost 0 when all global token totals are zero', () => {
    const task = {
      taskId: taskId('T001'),
      taskTitle: 'test',
      method: 'local' as const,
      implementerTokens: 0,
      escalationTokens: 0,
      retryCount: 0,
    };
    const globalUsage = {
      implementerInput: 0,
      implementerOutput: 0,
      escalationInput: 0,
      escalationOutput: 0,
    };
    const cost = calculateTaskUsageCost({
      task: task,
      tokenUsage: globalUsage,
      implementerTool: 'ollama',
      plannerTool: 'claude-code',
    });
    expect(cost).toBe(0);
  });

  it('allocates cost uniformly across tasks regardless of individual token usage', () => {
    const globalUsage = {
      implementerInput: 600_000,
      implementerOutput: 400_000,
      escalationInput: 0,
      escalationOutput: 0,
    };
    const heavyTask = {
      taskId: taskId('T001'),
      taskTitle: 'heavy',
      method: 'local' as const,
      implementerTokens: 800_000,
      escalationTokens: 0,
      retryCount: 0,
    };
    const lightTask = {
      taskId: taskId('T002'),
      taskTitle: 'light',
      method: 'local' as const,
      implementerTokens: 200_000,
      escalationTokens: 0,
      retryCount: 0,
    };

    const heavyCost = calculateTaskUsageCost({
      task: heavyTask,
      tokenUsage: globalUsage,
      implementerTool: 'deepseek',
      plannerTool: 'claude-code',
    });
    const lightCost = calculateTaskUsageCost({
      task: lightTask,
      tokenUsage: globalUsage,
      implementerTool: 'deepseek',
      plannerTool: 'claude-code',
    });

    // Per-task cost uses blended rate × task tokens — tasks with more tokens cost proportionally more
    expect(heavyCost / lightCost).toBeCloseTo(800_000 / 200_000, 5);
    // Both use the same blended cost-per-token derived from global input/output ratio
    expect(heavyCost / 800_000).toBeCloseTo(lightCost / 200_000, 10);
  });
});
