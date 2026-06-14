import { describe, expect, it } from 'vitest';
import { calculateCostBreakdown, calculateTaskUsageCost, isTaskUsageCostKnown } from './cost.js';
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
    expect(result.savingsAmount).toBeCloseTo(0.001022, 10);
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

  it('computes savings only when the all-planner baseline is priced', () => {
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

    expect(result.savingsAmount).toBeCloseTo(result.hypotheticalCost - result.totalActualCost, 10);
    expect(result.savingsAmount).toBeGreaterThan(0);

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

  it('all-planner baseline includes planner spend without changing savings amount', () => {
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

    expect(high.hypotheticalCost).toBeGreaterThan(low.hypotheticalCost);
    expect(low.savingsAmount).toBeCloseTo(high.savingsAmount, 10);
    expect(low.hypotheticalCost).toBeCloseTo(
      low.actualPlannerCost + low.savingsAmount + low.actualImplementerCost,
      10,
    );
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

    expect(result.actualImplementerCost).toBeCloseTo(0.21, 10);
    const deepseek = result.providerCosts?.['deepseek'];
    if (!deepseek) throw new Error('expected deepseek provider costs');
    expect(deepseek.inputTokens).toBeCloseTo(500_000, 10);
    expect(deepseek.outputTokens).toBeCloseTo(500_000, 10);
    expect(deepseek.cost).toBeCloseTo(0.21, 10);
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

    expect(result.actualImplementerCost).toBeCloseTo(0.21, 10);
    expect(result.providerCosts?.['deepseek']?.cost).toBeCloseTo(0.21, 10);
  });

  it('prices empty taskBreakdowns as residual at the primary implementer identity', () => {
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
      taskBreakdowns: [],
    });

    expect(result.actualImplementerCost).toBeCloseTo(0.42, 10);
    const deepseek = result.providerCosts?.['deepseek'];
    if (!deepseek) throw new Error('expected deepseek provider costs');
    expect(deepseek.inputTokens).toBeCloseTo(1_000_000, 10);
    expect(deepseek.outputTokens).toBeCloseTo(1_000_000, 10);
    expect(deepseek.cost).toBeCloseTo(0.42, 10);
    expect(result.hasPricedUsage).toBe(true);
    expect(result.isActualImplementerCostKnown).toBe(true);
  });

  it('books the residual leg at the primary identity when breakdowns cover only part of the spend', () => {
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
          taskTitle: 'escalated task',
          method: 'escalated-full',
          implementerTokens: 500_000,
          escalationTokens: 0,
          retryCount: 0,
          tool: 'anthropic',
          model: 'claude-sonnet-4-6',
        },
      ],
    });

    const anthropic = result.providerCosts?.['anthropic'];
    if (!anthropic) throw new Error('expected anthropic provider costs');
    expect(anthropic.inputTokens).toBeCloseTo(250_000, 10);
    expect(anthropic.outputTokens).toBeCloseTo(250_000, 10);
    expect(anthropic.cost).toBeCloseTo(4.5, 10);

    const deepseek = result.providerCosts?.['deepseek'];
    if (!deepseek) throw new Error('expected deepseek residual provider costs');
    expect(deepseek.inputTokens).toBeCloseTo(750_000, 10);
    expect(deepseek.outputTokens).toBeCloseTo(750_000, 10);
    expect(deepseek.cost).toBeCloseTo(0.315, 10);

    expect(result.actualImplementerCost).toBeCloseTo(4.815, 10);
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
    expect(cost).toBeCloseTo((0.14 * 200_000) / 1_000_000 + (0.28 * 100_000) / 1_000_000, 6);
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

  it('includes escalation planner cache read/create in per-task cost', () => {
    const task = {
      taskId: taskId('T001'),
      taskTitle: 'test',
      method: 'escalated-full' as const,
      implementerTokens: 0,
      escalationTokens: 150_000,
      escalationCacheReadTokens: 1_000_000,
      escalationCacheCreateTokens: 1_000_000,
      retryCount: 0,
    };
    const globalUsage = {
      implementerInput: 0,
      implementerOutput: 0,
      escalationInput: 100_000,
      escalationOutput: 50_000,
      plannerCacheRead: 1_000_000,
      plannerCacheCreate: 1_000_000,
    };

    const cost = calculateTaskUsageCost({
      task,
      tokenUsage: globalUsage,
      implementerTool: 'ollama',
      plannerTool: 'anthropic',
      plannerModel: 'claude-sonnet-4-6',
    });

    expect(cost).toBeCloseTo(5.1, 6);
  });

  it('does not allocate planner-phase cache to an escalated task with explicit-zero cache fields', () => {
    const task = {
      taskId: taskId('T001'),
      taskTitle: 'test',
      method: 'escalated-full' as const,
      implementerTokens: 0,
      escalationTokens: 150_000,
      escalationCacheReadTokens: 0,
      escalationCacheCreateTokens: 0,
      retryCount: 0,
    };
    const globalUsage = {
      implementerInput: 0,
      implementerOutput: 0,
      escalationInput: 100_000,
      escalationOutput: 50_000,
      plannerCacheRead: 1_000_000,
      plannerCacheCreate: 1_000_000,
    };

    const cost = calculateTaskUsageCost({
      task,
      tokenUsage: globalUsage,
      implementerTool: 'ollama',
      plannerTool: 'anthropic',
      plannerModel: 'claude-sonnet-4-6',
    });

    // 100k input @ $3/MTok + 50k output @ $15/MTok = $0.30 + $0.75 = $1.05, with no cache dollars.
    expect(cost).toBeCloseTo(1.05, 6);
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

  it('honors exact per-task implementer cache fields instead of proportional allocation', () => {
    const globalUsage = {
      implementerInput: 600_000,
      implementerOutput: 400_000,
      escalationInput: 0,
      escalationOutput: 0,
      implementerCacheRead: 1_000_000,
      implementerCacheCreate: 0,
    };
    // Task accounts for half the global implementer tokens but carries the FULL cache read.
    const task = {
      taskId: taskId('T001'),
      taskTitle: 'exact-cache',
      method: 'local' as const,
      implementerTokens: 500_000,
      escalationTokens: 0,
      implementerCacheReadTokens: 1_000_000,
      implementerCacheCreateTokens: 0,
      retryCount: 0,
    };

    const cost = calculateTaskUsageCost({
      task,
      tokenUsage: globalUsage,
      implementerTool: 'anthropic',
      plannerTool: 'claude-code',
      implementerModel: 'claude-sonnet-4-6',
    });

    // 500k task tokens split 60/40 → 300k input @ $3/MTok ($0.90) + 200k output @ $15/MTok ($3.00)
    // = $3.90 base, plus the EXACT 1M cache read @ $0.30/MTok ($0.30) → $4.20. Proportional
    // allocation would have charged only half the cache read (500k → $0.15), giving $4.05.
    expect(cost).toBeCloseTo(4.2, 6);
  });

  it('attributes uneven exact cache fields per task: exact-0 and exact-1M against a shared 1M global', () => {
    const globalUsage = {
      implementerInput: 600_000,
      implementerOutput: 400_000,
      escalationInput: 0,
      escalationOutput: 0,
      implementerCacheRead: 1_000_000,
      implementerCacheCreate: 0,
    };
    // Both tasks account for half the global implementer tokens, so proportional allocation would
    // charge each 500k cache read ($0.15). Exact fields split it unevenly: one carries none, the
    // other carries the full 1M.
    const noCacheTask = {
      taskId: taskId('T001'),
      taskTitle: 'exact-zero-cache',
      method: 'local' as const,
      implementerTokens: 500_000,
      escalationTokens: 0,
      implementerCacheReadTokens: 0,
      implementerCacheCreateTokens: 0,
      retryCount: 0,
    };
    const fullCacheTask = {
      taskId: taskId('T002'),
      taskTitle: 'exact-full-cache',
      method: 'local' as const,
      implementerTokens: 500_000,
      escalationTokens: 0,
      implementerCacheReadTokens: 1_000_000,
      implementerCacheCreateTokens: 0,
      retryCount: 0,
    };

    const args = {
      tokenUsage: globalUsage,
      implementerTool: 'anthropic',
      plannerTool: 'claude-code',
      implementerModel: 'claude-sonnet-4-6',
    };
    const noCacheCost = calculateTaskUsageCost({ ...args, task: noCacheTask });
    const fullCacheCost = calculateTaskUsageCost({ ...args, task: fullCacheTask });

    // Base each leg: 300k input @ $3/MTok ($0.90) + 200k output @ $15/MTok ($3.00) = $3.90.
    // Exact attribution: exact-zero leg = $3.90, exact-1M leg = $3.90 + 1M @ $0.30/MTok = $4.20.
    // Proportional allocation would have charged both legs the same $4.05 (500k cache each).
    expect(noCacheCost).toBeCloseTo(3.9, 6);
    expect(fullCacheCost).toBeCloseTo(4.2, 6);
    expect(fullCacheCost - noCacheCost).toBeCloseTo(0.3, 6);
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

describe('isTaskUsageCostKnown — cache alignment with calculateTaskUsageCost', () => {
  it('reports unknown when a legacy implementer record allocates cache tokens a priced-but-cache-unpriced tool cannot price', () => {
    const task = {
      taskId: taskId('T001'),
      taskTitle: 'legacy-no-cache-fields',
      method: 'local' as const,
      implementerTokens: 500_000,
      escalationTokens: 0,
      retryCount: 0,
    };
    const globalUsage = {
      implementerInput: 600_000,
      implementerOutput: 400_000,
      escalationInput: 0,
      escalationOutput: 0,
      implementerCacheRead: 1_000_000,
    };

    const args = {
      task,
      tokenUsage: globalUsage,
      implementerTool: 'deepseek',
      plannerTool: 'claude-code',
      implementerModel: 'deepseek-chat',
    };

    // deepseek prices input/output but has no cache rate, so calculateTaskUsageCost silently drops
    // the allocated cache-read cost — a finite, partial number. isTaskUsageCostKnown must surface
    // that the figure is incomplete by pricing the SAME allocated cache tokens.
    expect(calculateTaskUsageCost(args)).toBeGreaterThan(0);
    expect(isTaskUsageCostKnown(args)).toBe(false);
  });

  it('reports known when an implementer record carries explicit-zero cache fields (no cache to price)', () => {
    const task = {
      taskId: taskId('T001'),
      taskTitle: 'explicit-zero-cache',
      method: 'local' as const,
      implementerTokens: 500_000,
      escalationTokens: 0,
      implementerCacheReadTokens: 0,
      implementerCacheCreateTokens: 0,
      retryCount: 0,
    };
    const globalUsage = {
      implementerInput: 600_000,
      implementerOutput: 400_000,
      escalationInput: 0,
      escalationOutput: 0,
      implementerCacheRead: 1_000_000,
    };

    expect(
      isTaskUsageCostKnown({
        task,
        tokenUsage: globalUsage,
        implementerTool: 'deepseek',
        plannerTool: 'claude-code',
        implementerModel: 'deepseek-chat',
      }),
    ).toBe(true);
  });

  it('reports unknown when a legacy escalated record allocates planner cache a cache-unpriced planner cannot price', () => {
    const task = {
      taskId: taskId('T001'),
      taskTitle: 'legacy-escalation',
      method: 'escalated-full' as const,
      implementerTokens: 0,
      escalationTokens: 150_000,
      retryCount: 0,
    };
    const globalUsage = {
      implementerInput: 0,
      implementerOutput: 0,
      escalationInput: 100_000,
      escalationOutput: 50_000,
      plannerCacheRead: 1_000_000,
    };

    expect(
      isTaskUsageCostKnown({
        task,
        tokenUsage: globalUsage,
        implementerTool: 'ollama',
        plannerTool: 'deepseek',
        plannerModel: 'deepseek-chat',
      }),
    ).toBe(false);
  });

  it('reports known when both legs are fully priced including cache rates', () => {
    const task = {
      taskId: taskId('T001'),
      taskTitle: 'fully-priced',
      method: 'escalated-full' as const,
      implementerTokens: 0,
      escalationTokens: 150_000,
      escalationCacheReadTokens: 1_000_000,
      escalationCacheCreateTokens: 0,
      retryCount: 0,
    };
    const globalUsage = {
      implementerInput: 0,
      implementerOutput: 0,
      escalationInput: 100_000,
      escalationOutput: 50_000,
      plannerCacheRead: 1_000_000,
    };

    expect(
      isTaskUsageCostKnown({
        task,
        tokenUsage: globalUsage,
        implementerTool: 'ollama',
        plannerTool: 'anthropic',
        plannerModel: 'claude-sonnet-4-6',
      }),
    ).toBe(true);
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
