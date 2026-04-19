import { describe, expect, it } from 'vitest';
import { calculateCost, calculateCostBreakdown, getModelPricing, getProviderPricing } from './pricing.js';
import { makeUsage } from '#testing/helpers/factories/summary.js';

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
});

describe('getModelPricing', () => {
  it('returns pricing for known API models', () => {
    expect(getModelPricing('claude-opus-4-6')).toMatchObject({
      inputPer1M: 5,
      outputPer1M: 25,
      isPriced: true,
    });
  });

  it('returns undefined for unknown models', () => {
    expect(getModelPricing('totally-unknown-model')).toBeUndefined();
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
