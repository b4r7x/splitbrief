import { describe, expect, it } from 'vitest';
import {
  calculateCostBreakdown,
  describeOfferingBillingPresentation,
  formatOfferingAwareExtraCost,
  resolveProviderRunMetadata,
} from './breakdown.js';
import type { ProviderRunMetadata } from '../../../core/schemas/summary.js';
import { makeUsage } from '#testing/helpers/factories/summary.js';
import { taskId } from '../../../core/schemas/task.js';
import { CostBreakdownSchema } from '../../../core/schemas/summary.js';

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
      plannerModel: 'claude-sonnet-5',
      implementerTool: 'deepseek',
      implementerModel: 'deepseek-v4-flash',
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
      plannerModel: 'claude-sonnet-5',
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
      plannerModel: 'claude-sonnet-5',
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
      plannerModel: 'claude-sonnet-5',
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
      plannerModel: 'claude-sonnet-5',
      implementerTool: 'deepseek',
      implementerModel: 'deepseek-v4-flash',
    });
    expect(result.savingsAmount).toBeCloseTo(0.000672, 10);
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
      plannerModel: 'claude-sonnet-5',
      implementerModel: 'deepseek-v4-flash',
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

  it('preserves negative savings when routed execution is more expensive than all-planner', () => {
    const usage = makeUsage({
      implementerInput: 1_000_000,
      implementerOutput: 1_000_000,
    });

    const result = calculateCostBreakdown({
      tokenUsage: usage,
      totalTasks: 1,
      escalatedCount: 0,
      plannerTool: 'deepseek',
      plannerModel: 'deepseek-v4-flash',
      implementerTool: 'anthropic',
      implementerModel: 'claude-sonnet-5',
    });

    expect(result.hasSavingsEstimate).toBe(true);
    expect(result.savingsAmount).toBeCloseTo(result.hypotheticalCost - result.totalActualCost, 10);
    expect(result.savingsAmount).toBeLessThan(0);
    expect(result.savingsPercentage).toBeLessThan(0);
  });

  it('all-planner baseline includes planner spend without changing savings amount', () => {
    const sharedImplementer = { implementerInput: 500_000, implementerOutput: 200_000 };

    const low = calculateCostBreakdown({
      tokenUsage: makeUsage({ plannerInput: 10_000, plannerOutput: 5_000, ...sharedImplementer }),
      totalTasks: 1,
      escalatedCount: 0,
      plannerTool: 'anthropic',
      implementerTool: 'deepseek',
      plannerModel: 'claude-sonnet-5',
      implementerModel: 'deepseek-v4-flash',
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
      plannerModel: 'claude-sonnet-5',
      implementerModel: 'deepseek-v4-flash',
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
      plannerModel: 'deepseek-v4-flash',
      implementerModel: 'deepseek-v4-flash',
    });

    expect(result.providerCosts).toEqual({
      deepseek: {
        inputTokens: 300_000,
        outputTokens: 150_000,
        cost: result.totalActualCost,
      },
    });
  });

  it('uses per-task implementer tool identity for mixed local and paid profile costs', () => {
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
      implementerModel: 'deepseek-v4-flash',
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
          model: 'deepseek-v4-flash',
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
      implementerModel: 'deepseek-v4-flash',
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
      implementerModel: 'deepseek-v4-flash',
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
      implementerModel: 'deepseek-v4-flash',
      taskBreakdowns: [
        {
          taskId: taskId('T001'),
          taskTitle: 'escalated task',
          method: 'escalated-full',
          implementerTokens: 500_000,
          escalationTokens: 0,
          retryCount: 0,
          tool: 'anthropic',
          model: 'claude-sonnet-5',
        },
      ],
    });

    const anthropic = result.providerCosts?.['anthropic'];
    if (!anthropic) throw new Error('expected anthropic provider costs');
    expect(anthropic.inputTokens).toBeCloseTo(250_000, 10);
    expect(anthropic.outputTokens).toBeCloseTo(250_000, 10);
    expect(anthropic.cost).toBeCloseTo(3, 10);

    const deepseek = result.providerCosts?.['deepseek'];
    if (!deepseek) throw new Error('expected deepseek residual provider costs');
    expect(deepseek.inputTokens).toBeCloseTo(750_000, 10);
    expect(deepseek.outputTokens).toBeCloseTo(750_000, 10);
    expect(deepseek.cost).toBeCloseTo(0.315, 10);

    expect(result.actualImplementerCost).toBeCloseTo(3.315, 10);
  });

  it('includes cache-only task-aware implementer usage', () => {
    const usage = makeUsage({
      implementerCacheRead: 1_000_000,
    });

    const result = calculateCostBreakdown({
      tokenUsage: usage,
      totalTasks: 1,
      escalatedCount: 0,
      plannerTool: 'claude-code',
      implementerTool: 'ollama',
      taskBreakdowns: [
        {
          taskId: taskId('T001'),
          taskTitle: 'cache-only paid task',
          method: 'local',
          implementerTokens: 0,
          escalationTokens: 0,
          implementerCacheReadTokens: 1_000_000,
          implementerCacheCreateTokens: 0,
          retryCount: 0,
          tool: 'anthropic',
          model: 'claude-sonnet-5',
        },
      ],
    });

    expect(result.actualImplementerCost).toBeCloseTo(0.2, 10);
    expect(result.isActualImplementerCostKnown).toBe(true);
    expect(result.hasPricedUsage).toBe(true);
    expect(result.hasUnpricedUsage).toBe(false);
    expect(result.providerCosts).toEqual({
      anthropic: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 1_000_000,
        cost: result.actualImplementerCost,
      },
    });
  });

  it('does not mark planner-only runs unpriced because the unused implementer is local', () => {
    const usage = makeUsage({
      plannerInput: 100_000,
      plannerOutput: 50_000,
    });

    const result = calculateCostBreakdown({
      tokenUsage: usage,
      totalTasks: 0,
      escalatedCount: 0,
      plannerTool: 'anthropic',
      plannerModel: 'claude-sonnet-5',
      implementerTool: 'ollama',
    });

    expect(result.actualPlannerCost).toBeGreaterThan(0);
    expect(result.actualImplementerCost).toBe(0);
    expect(result.hasPricedUsage).toBe(true);
    expect(result.hasUnpricedUsage).toBe(false);
    expect(result.isTotalActualCostKnown).toBe(true);
  });
});

describe('offering billing metadata', () => {
  it('meters PAYG when usage exists', () => {
    const metadata = resolveProviderRunMetadata({
      tool: 'deepseek',
      normalizedEndpoint: 'https://api.deepseek.com/v1',
    });
    expect(metadata).toMatchObject({
      service: 'deepseek',
      offering: 'payg',
      billing: 'api-metered',
      normalizedEndpoint: 'https://api.deepseek.com/v1',
      asOf: '2026-07-31',
    });

    const presentation = describeOfferingBillingPresentation(metadata!, {
      hasUsage: true,
      meteredCost: 0.21,
    });
    expect(presentation.costLabel).toBe('$0.21');
    expect(presentation.billingLabel).toBe('api-metered');
  });

  it('labels subscription-included quota without a PAYG charge', () => {
    const metadata = resolveProviderRunMetadata({ tool: 'claude-code' });
    expect(metadata).toMatchObject({
      service: 'claude-code',
      offering: 'coding-subscription',
      billing: 'subscription-included',
      normalizedEndpoint: 'cli:claude',
      asOf: '2026-07-31',
    });

    const presentation = describeOfferingBillingPresentation(metadata!, {
      hasUsage: true,
      meteredCost: 0,
    });
    expect(presentation.costLabel).toBe('subscription-included');
    expect(presentation.billingLabel).toBe('subscription-included');
    expect(presentation.costLabel).not.toMatch(/\$0 extra|free|local/i);
    expect(formatOfferingAwareExtraCost(metadata!, 0)).toBeNull();
    expect(formatOfferingAwareExtraCost(metadata!, 1.25)).toBeNull();
  });

  it('describes free quota as variable', () => {
    const metadata: ProviderRunMetadata = {
      service: 'gemini',
      offering: 'free-quota',
      normalizedEndpoint: 'https://generativelanguage.googleapis.com/v1beta/openai',
      billing: 'provider-dependent',
      asOf: '2026-07-31',
    };

    const presentation = describeOfferingBillingPresentation(metadata, { hasUsage: true });
    expect(presentation.costLabel).toBe('variable quota');
    expect(presentation.costLabel).not.toMatch(/free|unlimited|guaranteed/i);
  });

  it('labels local compute local', () => {
    const metadata = resolveProviderRunMetadata({
      tool: 'ollama',
      normalizedEndpoint: 'http://localhost:11434/v1',
    });
    expect(metadata).toMatchObject({
      service: 'ollama',
      offering: 'local',
      billing: 'local',
      normalizedEndpoint: 'http://localhost:11434/v1',
      asOf: '2026-07-31',
    });

    const presentation = describeOfferingBillingPresentation(metadata!, { hasUsage: true });
    expect(presentation.costLabel).toBe('local');
    expect(presentation.billingLabel).toBe('local');
  });

  it('carries offering metadata through calculateCostBreakdown', () => {
    const usage = makeUsage({
      plannerInput: 100_000,
      plannerOutput: 50_000,
      implementerInput: 500_000,
      implementerOutput: 200_000,
    });

    const result = calculateCostBreakdown({
      tokenUsage: usage,
      totalTasks: 1,
      escalatedCount: 0,
      plannerTool: 'anthropic',
      plannerModel: 'claude-sonnet-5',
      implementerTool: 'ollama',
      implementerModel: 'qwen-local',
    });

    expect(result.providerRunMetadata?.anthropic).toMatchObject({
      service: 'anthropic',
      offering: 'payg',
      billing: 'api-metered',
      asOf: '2026-07-31',
    });
    expect(result.providerRunMetadata?.ollama).toMatchObject({
      service: 'ollama',
      offering: 'local',
      billing: 'local',
      asOf: '2026-07-31',
    });
    expect(result.offeringPresentations?.anthropic?.costLabel).toMatch(/^\$/);
    expect(result.offeringPresentations?.ollama?.costLabel).toBe('local');
  });
});

describe('summary persistence', () => {
  it('keeps run metadata and offering presentations through the summary schema', () => {
    const result = calculateCostBreakdown({
      tokenUsage: makeUsage({
        plannerInput: 100_000,
        plannerOutput: 50_000,
        implementerInput: 200_000,
        implementerOutput: 100_000,
      }),
      totalTasks: 2,
      escalatedCount: 0,
      plannerTool: 'claude-code',
      implementerTool: 'deepseek',
      implementerModel: 'deepseek-v4-flash',
    });

    const parsed = CostBreakdownSchema.parse(result);

    expect(parsed.providerRunMetadata?.['claude-code']).toMatchObject({
      offering: 'coding-subscription',
      billing: 'subscription-included',
    });
    expect(parsed.offeringPresentations?.['claude-code']?.costLabel).toBe('subscription-included');
    expect(parsed.providerRunMetadata).toEqual(result.providerRunMetadata);
    expect(parsed.offeringPresentations).toEqual(result.offeringPresentations);
  });
});

describe('cache pricing', () => {
  it('calculateCostBreakdown with cacheRead tokens + priced provider returns correct cacheReadSavings', () => {
    // Sonnet 5: input=$2/MTok, cacheRead=$0.20/MTok => savings=$1.80/MTok of cache reads
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
      plannerModel: 'claude-sonnet-5',
      implementerModel: 'deepseek-v4-flash',
    });

    // 1_000_000 cache read tokens at (2.00 - 0.20) = $1.80/MTok = $1.80 savings
    expect(result.cacheReadSavings).toBeCloseTo(1.8, 10);
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
      plannerModel: 'claude-sonnet-5',
      implementerModel: 'deepseek-v4-flash',
    });

    expect(result.cacheReadSavings).toBeUndefined();
    expect(result.cacheReadTokens).toBeUndefined();
    expect(result.cacheWriteTokens).toBeUndefined();
  });

  it('calculateCostBreakdown accumulates cache savings across both planner and implementer', () => {
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
      plannerModel: 'claude-sonnet-5',
      implementerModel: 'claude-sonnet-5',
    });

    // (500k + 500k) @ $1.80/MTok = $1.80 total
    expect(result.cacheReadSavings).toBeCloseTo(1.8, 10);
    expect(result.cacheReadTokens).toBe(1_000_000);
  });
});

describe('reviewer pricing', () => {
  const anthropicPlanner = {
    plannerTool: 'anthropic',
    plannerModel: 'claude-sonnet-5',
    implementerTool: 'deepseek',
    implementerModel: 'deepseek-v4-flash',
  } as const;

  it('folds reviewer tokens into the planner line when no reviewer is configured', () => {
    const withReviewerBucket = calculateCostBreakdown({
      tokenUsage: makeUsage({
        plannerInput: 100_000,
        plannerOutput: 40_000,
        reviewerInput: 20_000,
        reviewerOutput: 5_000,
        implementerInput: 400_000,
        implementerOutput: 100_000,
      }),
      totalTasks: 4,
      escalatedCount: 0,
      ...anthropicPlanner,
    });
    const preChange = calculateCostBreakdown({
      tokenUsage: makeUsage({
        plannerInput: 120_000,
        plannerOutput: 45_000,
        implementerInput: 400_000,
        implementerOutput: 100_000,
      }),
      totalTasks: 4,
      escalatedCount: 0,
      ...anthropicPlanner,
    });

    expect(withReviewerBucket).toEqual(preChange);
  });

  it('prices a configured reviewer as its own line at the reviewer rates', () => {
    const result = calculateCostBreakdown({
      tokenUsage: makeUsage({
        plannerInput: 100_000,
        plannerOutput: 40_000,
        reviewerInput: 20_000,
        reviewerOutput: 5_000,
      }),
      totalTasks: 1,
      escalatedCount: 0,
      plannerTool: 'anthropic',
      plannerModel: 'claude-sonnet-5',
      implementerTool: 'ollama',
      reviewerTool: 'deepseek',
      reviewerModel: 'deepseek-v4-flash',
    });
    const reviewerAlone = calculateCostBreakdown({
      tokenUsage: makeUsage({ plannerInput: 20_000, plannerOutput: 5_000 }),
      totalTasks: 1,
      escalatedCount: 0,
      plannerTool: 'deepseek',
      plannerModel: 'deepseek-v4-flash',
      implementerTool: 'ollama',
    });

    expect(result.providerCosts?.deepseek).toEqual({
      inputTokens: 20_000,
      outputTokens: 5_000,
      cost: reviewerAlone.actualPlannerCost,
    });
    expect(result.providerCosts?.anthropic?.inputTokens).toBe(100_000);
    expect(result.totalActualCost).toBeCloseTo(
      result.actualPlannerCost + result.actualImplementerCost + reviewerAlone.actualPlannerCost,
      10,
    );
  });

  it('suppresses the savings estimate when the configured reviewer is unpriced', () => {
    const result = calculateCostBreakdown({
      tokenUsage: makeUsage({
        plannerInput: 100_000,
        plannerOutput: 40_000,
        reviewerInput: 20_000,
        reviewerOutput: 5_000,
        implementerInput: 400_000,
        implementerOutput: 100_000,
      }),
      totalTasks: 4,
      escalatedCount: 0,
      ...anthropicPlanner,
      reviewerTool: 'opencode',
    });

    expect(result.isTotalActualCostKnown).toBe(false);
    expect(result.hasSavingsEstimate).toBe(false);
  });
});
