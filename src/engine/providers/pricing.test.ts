import { describe, expect, it } from 'vitest';
import { calculateCost, calculateCostBreakdown, calculateUsageCost, getProviderPricing } from './pricing.js';
import { makeUsage } from '#testing/helpers/factories/summary.js';
import { CostBreakdownSchema } from '../../core/schemas/summary.js';
import { taskId } from '../../core/schemas/task.js';

describe('calculateCost', () => {
  it('returns 0 for unpriced providers', () => {
    const pricing = getProviderPricing('claude-code', 'opus');
    expect(pricing.isPriced).toBe(false);
    expect(calculateCost(500_000, 500_000, pricing)).toBe(0);
  });

  it('calculates priced API usage', () => {
    const pricing = getProviderPricing('anthropic', 'claude-sonnet-4-6');
    expect(calculateCost(1_000_000, 1_000_000, pricing)).toBe(18);
  });
});

describe('calculateUsageCost', () => {
  it('includes cache read and create costs when known', () => {
    const pricing = getProviderPricing('anthropic', 'claude-sonnet-4-6');
    expect(calculateUsageCost(1_000_000, 1_000_000, 1_000_000, 1_000_000, pricing)).toBeCloseTo(22.05, 10);
  });

  it('returns zero for unknown models with unpriced fallback', () => {
    const pricing = getProviderPricing('unknown-provider', 'totally-unknown-model');
    expect(calculateUsageCost(1_000_000, 1_000_000, 1_000_000, 1_000_000, pricing)).toBe(0);
  });
});

describe('calculateCostBreakdown', () => {
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
    expect(result.savingsAmount).toBeCloseTo(result.hypotheticalCost - result.actualImplementerCost, 10);
    expect(result.savingsAmount).toBeGreaterThan(0);

    // savingsPercentage uses hypotheticalCost as the 100% baseline.
    expect(result.savingsPercentage).toBeCloseTo((result.savingsAmount / result.hypotheticalCost) * 100, 10);

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
      totalTasks: 1, escalatedCount: 0,
      plannerTool: 'anthropic', implementerTool: 'deepseek',
      plannerModel: 'claude-sonnet-4-6', implementerModel: 'deepseek-chat',
    });

    const high = calculateCostBreakdown({
      tokenUsage: makeUsage({ plannerInput: 1_000_000, plannerOutput: 500_000, ...sharedImplementer }),
      totalTasks: 1, escalatedCount: 0,
      plannerTool: 'anthropic', implementerTool: 'deepseek',
      plannerModel: 'claude-sonnet-4-6', implementerModel: 'deepseek-chat',
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
        { taskId: taskId('T001'), taskTitle: 'local task', method: 'local', implementerTokens: 1_000_000, escalationTokens: 0, retryCount: 0, tool: 'ollama', model: 'qwen-local' },
        { taskId: taskId('T002'), taskTitle: 'paid task', method: 'local', implementerTokens: 1_000_000, escalationTokens: 0, retryCount: 0, tool: 'deepseek', model: 'deepseek-chat' },
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
        { taskId: taskId('T001'), taskTitle: 'unknown task', method: 'local', implementerTokens: 2_000_000, escalationTokens: 0, retryCount: 0, tool: 'custom-agent', model: 'private-model' },
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
        { taskId: taskId('T001'), taskTitle: 'paid auto task', method: 'local', implementerTokens: 1_000_000, escalationTokens: 0, retryCount: 0, tool: 'deepseek', model: 'auto' },
      ],
    });

    expect(result.actualImplementerCost).toBeCloseTo(0.35, 10);
    expect(result.providerCosts?.['deepseek']?.cost).toBeCloseTo(0.35, 10);
  });
});

describe('getProviderPricing', () => {
  it('returns unpriced metadata for CLI tools', () => {
    const pricing = getProviderPricing('claude-code', 'default');
    expect(pricing).toMatchObject({
      isPriced: false,
      pricingMode: 'unpriced-cli',
    });
  });

  it('returns local pricing for local providers', () => {
    const pricing = getProviderPricing('ollama');
    expect(pricing).toMatchObject({
      isPriced: false,
      pricingMode: 'unpriced-local',
      isLocal: true,
    });
  });

  it('returns bundled fallback pricing for anthropic without explicit model', () => {
    const pricing = getProviderPricing('anthropic');
    expect(pricing).toMatchObject({
      inputPer1M: 3,
      outputPer1M: 15,
      isPriced: true,
    });
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
    expect(result.cacheReadSavings).toBeCloseTo(2.70, 10);
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
    expect(result.cacheReadSavings).toBeCloseTo(2.70, 10);
    expect(result.cacheReadTokens).toBe(1_000_000);
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
