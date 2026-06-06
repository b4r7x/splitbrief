import { describe, expect, it } from 'vitest';
import { calculateCostBreakdown, calculateTaskUsageCost } from './cost.js';
import { makeUsage } from '#testing/helpers/factories/summary.js';
import { CostBreakdownSchema } from '../../core/schemas/summary.js';
import { taskId } from '../../core/schemas/task.js';

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

  it('treats CLI + local workflows as unpriced', () => {
    const usage = makeUsage({
      plannerInput: 100_000,
      plannerOutput: 50_000,
      implementerInput: 500_000,
      implementerOutput: 200_000,
    });

    const result = calculateCostBreakdown({
      tokenUsage: usage,
      totalTasks: 5,
      escalatedCount: 0,
      plannerTool: 'claude-code',
      implementerTool: 'ollama',
    });

    expect(result.totalActualCost).toBe(0);
    expect(result.providerCosts).toBeUndefined();
    expect(result.hasPricedUsage).toBe(false);
    expect(result.hasSavingsEstimate).toBe(false);
    expect(result.hasUnpricedUsage).toBe(true);
  });

  it('includes only API-priced providers in providerCosts', () => {
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
      plannerTool: 'claude-code',
      implementerTool: 'deepseek',
    });

    expect(result.providerCosts).toEqual({
      deepseek: {
        inputTokens: 1_000_000,
        outputTokens: 500_000,
        cost: result.actualImplementerCost,
      },
    });
    expect(result.actualPlannerCost).toBe(0);
    expect(result.actualImplementerCost).toBeGreaterThan(0);
    expect(result.hasPricedUsage).toBe(true);
    expect(result.hasSavingsEstimate).toBe(false);
  });

  it('computes savings only when planner is API-priced', () => {
    const usage = makeUsage({
      plannerInput: 100_000,
      plannerOutput: 50_000,
      implementerInput: 500_000,
      implementerOutput: 200_000,
    });

    const result = calculateCostBreakdown({
      tokenUsage: usage,
      totalTasks: 3,
      escalatedCount: 1,
      plannerTool: 'anthropic',
      implementerTool: 'deepseek',
      plannerModel: 'claude-sonnet-4-6',
      implementerModel: 'deepseek-chat',
    });

    expect(result.actualPlannerCost).toBeGreaterThan(0);
    expect(result.actualImplementerCost).toBeGreaterThan(0);
    expect(result.hasSavingsEstimate).toBe(true);

    // savingsAmount = hypotheticalCost (implementer tokens @ planner rate) - actualImplementerCost.
    // It must NOT deduct plannerCost — planner spend is fixed regardless of implementer choice.
    expect(result.savingsAmount).toBeCloseTo(
      result.hypotheticalCost - result.actualImplementerCost,
      10,
    );
    expect(result.savingsAmount).toBeGreaterThan(0);

    // savingsPercentage uses hypotheticalCost as the 100% baseline.
    expect(result.savingsPercentage).toBeCloseTo(
      (result.savingsAmount / result.hypotheticalCost) * 100,
      10,
    );

    expect(result.providerCosts).toEqual({
      anthropic: {
        inputTokens: 100_000,
        outputTokens: 50_000,
        cost: result.actualPlannerCost,
      },
      deepseek: {
        inputTokens: 500_000,
        outputTokens: 200_000,
        cost: result.actualImplementerCost,
      },
    });
  });

  it('savings formula excludes planner cost from both sides', () => {
    // Verify: changing planner token usage does not affect savingsAmount.
    const sharedImplementer = { implementerInput: 500_000, implementerOutput: 200_000 };

    const low = calculateCostBreakdown({
      tokenUsage: makeUsage({ plannerInput: 10_000, plannerOutput: 5_000, ...sharedImplementer }),
      totalTasks: 1,
      escalatedCount: 0,
      plannerTool: 'anthropic',
      implementerTool: 'deepseek',
      plannerModel: 'claude-sonnet-4-6',
      implementerModel: 'deepseek-chat',
    });

    const high = calculateCostBreakdown({
      tokenUsage: makeUsage({
        plannerInput: 1_000_000,
        plannerOutput: 500_000,
        ...sharedImplementer,
      }),
      totalTasks: 1,
      escalatedCount: 0,
      plannerTool: 'anthropic',
      implementerTool: 'deepseek',
      plannerModel: 'claude-sonnet-4-6',
      implementerModel: 'deepseek-chat',
    });

    // hypotheticalCost (implementer tokens @ planner rate) is identical — same implementer tokens.
    expect(low.hypotheticalCost).toBeCloseTo(high.hypotheticalCost, 10);
    // savingsAmount must be identical regardless of how much the planner consumed.
    expect(low.savingsAmount).toBeCloseTo(high.savingsAmount, 10);
  });

  it('treats agent-sdk planner as unpriced-meta with no savings estimate', () => {
    const usage = makeUsage({
      plannerInput: 100_000,
      plannerOutput: 50_000,
      implementerInput: 500_000,
      implementerOutput: 200_000,
    });

    const result = calculateCostBreakdown({
      tokenUsage: usage,
      totalTasks: 3,
      escalatedCount: 0,
      plannerTool: 'agent-sdk',
      implementerTool: 'ollama',
    });

    expect(result.hasSavingsEstimate).toBe(false);
    expect(result.savingsAmount).toBe(0);
    expect(result.hypotheticalCost).toBe(0);
    expect(result.totalActualCost).toBe(0);
  });

  it('merges priced planner and implementer usage when they share a provider', () => {
    const usage = makeUsage({
      plannerInput: 100_000,
      plannerOutput: 50_000,
      implementerInput: 200_000,
      implementerOutput: 100_000,
    });

    const result = calculateCostBreakdown({
      tokenUsage: usage,
      totalTasks: 2,
      escalatedCount: 0,
      plannerTool: 'deepseek',
      implementerTool: 'deepseek',
      plannerModel: 'deepseek-chat',
      implementerModel: 'deepseek-chat',
    });

    expect(result.providerCosts).toEqual({
      deepseek: {
        inputTokens: 300_000,
        outputTokens: 150_000,
        cost: result.totalActualCost,
      },
    });
  });

  it('uses per-task implementer metadata for mixed local and paid profile costs', () => {
    const usage = makeUsage({
      implementerInput: 1_000_000,
      implementerOutput: 1_000_000,
    });

    const result = calculateCostBreakdown({
      tokenUsage: usage,
      totalTasks: 2,
      escalatedCount: 0,
      plannerTool: 'claude-code',
      implementerTool: 'deepseek',
      implementerModel: 'deepseek-chat',
      taskBreakdowns: [
        {
          taskId: taskId('T001'),
          taskTitle: 'local task',
          method: 'local',
          implementerTokens: 1_000_000,
          escalationTokens: 0,
          retryCount: 0,
          tool: 'ollama',
          model: 'qwen-local',
        },
        {
          taskId: taskId('T002'),
          taskTitle: 'paid task',
          method: 'local',
          implementerTokens: 1_000_000,
          escalationTokens: 0,
          retryCount: 0,
          tool: 'deepseek',
          model: 'deepseek-chat',
        },
      ],
    });

    expect(result.actualImplementerCost).toBeCloseTo(0.35, 10);
    const deepseek = result.providerCosts?.['deepseek'];
    if (!deepseek) throw new Error('expected deepseek provider costs');
    expect(deepseek.inputTokens).toBeCloseTo(500_000, 10);
    expect(deepseek.outputTokens).toBeCloseTo(500_000, 10);
    expect(deepseek.cost).toBeCloseTo(0.35, 10);
    expect(result.hasPricedUsage).toBe(true);
    expect(result.hasUnpricedUsage).toBe(true);
  });

  it('does not price unknown per-task implementer usage with the fallback implementer model', () => {
    const usage = makeUsage({
      implementerInput: 1_000_000,
      implementerOutput: 1_000_000,
    });

    const result = calculateCostBreakdown({
      tokenUsage: usage,
      totalTasks: 1,
      escalatedCount: 0,
      plannerTool: 'claude-code',
      implementerTool: 'deepseek',
      implementerModel: 'deepseek-chat',
      taskBreakdowns: [
        {
          taskId: taskId('T001'),
          taskTitle: 'unknown task',
          method: 'local',
          implementerTokens: 2_000_000,
          escalationTokens: 0,
          retryCount: 0,
          tool: 'custom-agent',
          model: 'private-model',
        },
      ],
    });

    expect(result.actualImplementerCost).toBe(0);
    expect(result.providerCosts).toBeUndefined();
    expect(result.hasPricedUsage).toBe(false);
    expect(result.hasUnpricedUsage).toBe(true);
  });

  it('resolves task-level auto models against the recorded task tool', () => {
    const usage = makeUsage({
      implementerInput: 500_000,
      implementerOutput: 500_000,
    });

    const result = calculateCostBreakdown({
      tokenUsage: usage,
      totalTasks: 1,
      escalatedCount: 0,
      plannerTool: 'claude-code',
      implementerTool: 'ollama',
      implementerModel: 'qwen-local',
      taskBreakdowns: [
        {
          taskId: taskId('T001'),
          taskTitle: 'paid auto task',
          method: 'local',
          implementerTokens: 1_000_000,
          escalationTokens: 0,
          retryCount: 0,
          tool: 'deepseek',
          model: 'auto',
        },
      ],
    });

    expect(result.actualImplementerCost).toBeCloseTo(0.35, 10);
    expect(result.providerCosts?.['deepseek']?.cost).toBeCloseTo(0.35, 10);
  });
});

describe('cache pricing', () => {
  it('calculateCostBreakdown with cacheRead tokens + priced provider returns correct cacheReadSavings', () => {
    // Sonnet 4.6: input=$3/MTok, cacheRead=$0.30/MTok => savings=$2.70/MTok of cache reads
    const usage = makeUsage({
      plannerInput: 100_000,
      plannerOutput: 50_000,
      implementerInput: 500_000,
      implementerOutput: 200_000,
      plannerCacheRead: 1_000_000,
    });

    const result = calculateCostBreakdown({
      tokenUsage: usage,
      totalTasks: 3,
      escalatedCount: 0,
      plannerTool: 'anthropic',
      implementerTool: 'deepseek',
      plannerModel: 'claude-sonnet-4-6',
      implementerModel: 'deepseek-chat',
    });

    // 1_000_000 cache read tokens at (3.00 - 0.30) = $2.70/MTok = $2.70 savings
    expect(result.cacheReadSavings).toBeCloseTo(2.7, 10);
    expect(result.cacheReadTokens).toBe(1_000_000);
  });

  it('calculateCostBreakdown with cacheRead tokens + unpriced provider returns no cacheReadSavings', () => {
    const usage = makeUsage({
      plannerInput: 100_000,
      plannerOutput: 50_000,
      implementerInput: 500_000,
      implementerOutput: 200_000,
      plannerCacheRead: 1_000_000,
    });

    // claude-code is unpriced-cli — no cacheReadPer1M
    const result = calculateCostBreakdown({
      tokenUsage: usage,
      totalTasks: 3,
      escalatedCount: 0,
      plannerTool: 'claude-code',
      implementerTool: 'ollama',
    });

    expect(result.cacheReadSavings).toBeUndefined();
    expect(result.cacheReadTokens).toBe(1_000_000);
  });

  it('calculateCostBreakdown without cacheRead tokens returns no cacheReadSavings (backward compat)', () => {
    const usage = makeUsage({
      plannerInput: 100_000,
      plannerOutput: 50_000,
      implementerInput: 500_000,
      implementerOutput: 200_000,
    });

    const result = calculateCostBreakdown({
      tokenUsage: usage,
      totalTasks: 3,
      escalatedCount: 0,
      plannerTool: 'anthropic',
      implementerTool: 'deepseek',
      plannerModel: 'claude-sonnet-4-6',
      implementerModel: 'deepseek-chat',
    });

    expect(result.cacheReadSavings).toBeUndefined();
    expect(result.cacheReadTokens).toBeUndefined();
    expect(result.cacheWriteTokens).toBeUndefined();
  });

  it('calculateCostBreakdown accumulates cache savings across both planner and implementer', () => {
    // Both planner and implementer are anthropic/sonnet
    const usage = makeUsage({
      plannerInput: 100_000,
      plannerOutput: 50_000,
      implementerInput: 200_000,
      implementerOutput: 80_000,
      plannerCacheRead: 500_000,
      implementerCacheRead: 500_000,
    });

    const result = calculateCostBreakdown({
      tokenUsage: usage,
      totalTasks: 2,
      escalatedCount: 0,
      plannerTool: 'anthropic',
      implementerTool: 'anthropic',
      plannerModel: 'claude-sonnet-4-6',
      implementerModel: 'claude-sonnet-4-6',
    });

    // (500k + 500k) @ $2.70/MTok = $2.70 total
    expect(result.cacheReadSavings).toBeCloseTo(2.7, 10);
    expect(result.cacheReadTokens).toBe(1_000_000);
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

describe('CostBreakdown schema backward compatibility', () => {
  it('accepts old shape without cache fields', () => {
    const old = {
      hypotheticalCost: 1,
      actualPlannerCost: 0.5,
      actualImplementerCost: 0.2,
      totalActualCost: 0.7,
      savingsAmount: 0.3,
      savingsPercentage: 30,
      localCompletionRate: 0.5,
    };
    expect(() => CostBreakdownSchema.parse(old)).not.toThrow();
    const parsed = CostBreakdownSchema.parse(old);
    expect(parsed.cacheReadSavings).toBeUndefined();
    expect(parsed.cacheReadTokens).toBeUndefined();
    expect(parsed.cacheWriteTokens).toBeUndefined();
  });

  it('accepts new shape with cache fields', () => {
    const withCache = {
      hypotheticalCost: 1,
      actualPlannerCost: 0.5,
      actualImplementerCost: 0.2,
      totalActualCost: 0.7,
      savingsAmount: 0.3,
      savingsPercentage: 30,
      localCompletionRate: 0.5,
      cacheReadSavings: 2.7,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 500_000,
    };
    const parsed = CostBreakdownSchema.parse(withCache);
    expect(parsed.cacheReadSavings).toBe(2.7);
    expect(parsed.cacheReadTokens).toBe(1_000_000);
    expect(parsed.cacheWriteTokens).toBe(500_000);
  });
});
