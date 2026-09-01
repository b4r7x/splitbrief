import { describe, it, expect } from 'vitest';
import type { TokenUsage } from '../../../core/schemas/tokens.js';
import type { ModelCacheAccessor } from '../../providers/model/resolution.js';
import { getBudgetCostKnownness } from './knownness.js';
import { taskId } from '../../../core/schemas/task.js';
import { makeUsage } from '#testing/helpers/factories/summary.js';
import { makePricedModelCache } from '#testing/helpers/factories/model-cache.js';

// Pricing follows the model, so a metered seat needs a catalog to rate against.
const pricedCache = makePricedModelCache();

const zeroUsage = makeUsage();

function budgetKnownness(opts: Parameters<typeof getBudgetCostKnownness>[0]) {
  return getBudgetCostKnownness({ pricingCache: pricedCache, ...opts });
}

function currentKnownCost(opts: Parameters<typeof getBudgetCostKnownness>[0]): number {
  return budgetKnownness(opts).currentKnownCost;
}

describe('getBudgetCostKnownness', () => {
  it('returns 0 for zero usage with local tools', () => {
    expect(
      currentKnownCost({
        tokenUsage: zeroUsage,
        totalTasks: 1,
        escalatedCount: 0,
        plannerTool: 'ollama',
        implementerTool: 'ollama',
      }),
    ).toBe(0);
  });

  it('returns positive cost for a metered seat', () => {
    const usage: TokenUsage = {
      ...zeroUsage,
      plannerInput: 1_000_000,
      plannerOutput: 100_000,
    };
    const cost = currentKnownCost({
      tokenUsage: usage,
      totalTasks: 1,
      escalatedCount: 0,
      plannerTool: 'custom-planner-api',
      plannerModel: 'claude-sonnet-5',
      implementerTool: 'ollama',
    });
    expect(cost).toBeGreaterThan(0);
  });

  // The rate is whatever the caller's cache says about the seat's MODEL. A seat
  // whose model no catalog lists costs nothing knowable, and the same seat gains
  // a rate the moment a catalog carries that model.
  it('takes the current cost from the pricing cache the caller passes', () => {
    const pricingCache: ModelCacheAccessor = {
      getModelsDevCatalog: () => ({
        vendor: {
          id: 'vendor',
          models: {
            'budget-only-model': {
              id: 'budget-only-model',
              cost: { input: 10, output: 30 },
            },
          },
        },
      }),
      getProviderModels: () => null,
    };
    const usage: TokenUsage = {
      ...zeroUsage,
      plannerInput: 1_000_000,
      plannerOutput: 1_000_000,
    };

    const withoutCache = currentKnownCost({
      tokenUsage: usage,
      totalTasks: 1,
      escalatedCount: 0,
      plannerTool: 'custom-planner-api',
      plannerModel: 'budget-only-model',
      implementerTool: 'ollama',
    });
    const withCache = currentKnownCost({
      tokenUsage: usage,
      totalTasks: 1,
      escalatedCount: 0,
      plannerTool: 'custom-planner-api',
      plannerModel: 'budget-only-model',
      implementerTool: 'ollama',
      pricingCache,
    });

    expect(withoutCache).toBe(0);
    expect(withCache).toBe(40);
  });

  it('uses per-task metadata so paid profile tokens count even when the default implementer is local', () => {
    const usage: TokenUsage = {
      ...zeroUsage,
      implementerInput: 1_000_000,
      implementerOutput: 1_000_000,
    };

    const cost = currentKnownCost({
      tokenUsage: usage,
      totalTasks: 2,
      escalatedCount: 0,
      plannerTool: 'claude-code',
      implementerTool: 'ollama',
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
          tool: 'custom-worker-api',
          model: 'deepseek-v4-flash',
        },
      ],
    });

    expect(cost).toBeCloseTo(0.21, 10);
  });

  it('includes cache-only paid task usage in current cost and knownness', () => {
    const usage: TokenUsage = {
      ...zeroUsage,
      implementerCacheRead: 1_000_000,
    };
    const taskBreakdowns = [
      {
        taskId: taskId('T001'),
        taskTitle: 'cache-only paid task',
        method: 'local' as const,
        implementerTokens: 0,
        escalationTokens: 0,
        implementerCacheReadTokens: 1_000_000,
        implementerCacheCreateTokens: 0,
        retryCount: 0,
        tool: 'custom-planner-api',
        model: 'claude-sonnet-5',
      },
    ];

    const cost = currentKnownCost({
      tokenUsage: usage,
      totalTasks: 1,
      escalatedCount: 0,
      plannerTool: 'claude-code',
      implementerTool: 'ollama',
      taskBreakdowns,
    });
    const knownness = budgetKnownness({
      tokenUsage: usage,
      totalTasks: 1,
      escalatedCount: 0,
      plannerTool: 'claude-code',
      implementerTool: 'ollama',
      taskBreakdowns,
    });

    expect(cost).toBeCloseTo(0.2, 10);
    expect(knownness).toMatchObject({
      currentKnownCost: cost,
      isKnown: true,
      hasUnknownPaidUsage: false,
      hasLocalOnlyUnpricedUsage: false,
    });
  });

  it('marks cache-only paid task usage unknown when cache pricing is missing', () => {
    const usage: TokenUsage = {
      ...zeroUsage,
      implementerCacheRead: 1_000_000,
    };

    const knownness = budgetKnownness({
      tokenUsage: usage,
      totalTasks: 1,
      escalatedCount: 0,
      plannerTool: 'claude-code',
      implementerTool: 'ollama',
      taskBreakdowns: [
        {
          taskId: taskId('T001'),
          taskTitle: 'cache-only unpriced cache task',
          method: 'local',
          implementerTokens: 0,
          escalationTokens: 0,
          implementerCacheReadTokens: 1_000_000,
          retryCount: 0,
          tool: 'custom-worker-api',
          model: 'deepseek-v4-flash',
        },
      ],
    });

    expect(knownness).toMatchObject({
      currentKnownCost: 0,
      isKnown: false,
      hasUnknownPaidUsage: true,
      hasLocalOnlyUnpricedUsage: false,
      unknownReason: 'pricing unknown for custom-worker-api/deepseek-v4-flash',
    });
  });

  it('does not charge local profile tokens at the global paid implementer rate', () => {
    const usage: TokenUsage = {
      ...zeroUsage,
      implementerInput: 500_000,
      implementerOutput: 500_000,
    };

    const cost = currentKnownCost({
      tokenUsage: usage,
      totalTasks: 1,
      escalatedCount: 0,
      plannerTool: 'claude-code',
      implementerTool: 'custom-worker-api',
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
      ],
    });

    expect(cost).toBe(0);
  });

  it('classifies local-only unpriced usage as known for dollar budget purposes', () => {
    const usage: TokenUsage = {
      ...zeroUsage,
      implementerInput: 1_000_000,
      implementerOutput: 500_000,
    };

    const knownness = budgetKnownness({
      tokenUsage: usage,
      totalTasks: 1,
      escalatedCount: 0,
      plannerTool: 'ollama',
      implementerTool: 'ollama',
    });

    expect(knownness).toMatchObject({
      currentKnownCost: 0,
      isKnown: true,
      hasUnknownPaidUsage: false,
      hasLocalOnlyUnpricedUsage: true,
      unknownReason: null,
    });
  });

  it('uses models.dev context tiers for current budget cost', () => {
    const pricingCache: ModelCacheAccessor = {
      getModelsDevCatalog: () => ({
        openai: {
          id: 'openai',
          models: {
            'gpt-5.4': {
              id: 'gpt-5.4',
              cost: {
                input: 2.5,
                output: 15,
                tiers: [
                  {
                    input: 5,
                    output: 22.5,
                    tier: { type: 'context', size: 272000 },
                  },
                ],
              },
            },
          },
        },
      }),
      getProviderModels: () => null,
    };

    const below = currentKnownCost({
      tokenUsage: { ...zeroUsage, plannerInput: 200_000 },
      totalTasks: 1,
      escalatedCount: 0,
      plannerTool: 'custom-openai-api',
      plannerModel: 'gpt-5.4',
      implementerTool: 'ollama',
      pricingCache,
    });
    const above = currentKnownCost({
      tokenUsage: { ...zeroUsage, plannerInput: 300_000 },
      totalTasks: 1,
      escalatedCount: 0,
      plannerTool: 'custom-openai-api',
      plannerModel: 'gpt-5.4',
      implementerTool: 'ollama',
      pricingCache,
    });

    expect(below).toBeCloseTo(0.5, 10);
    expect(above).toBeCloseTo(1.5, 10);
  });

  it('attributes reviewer usage to the planner identity when no reviewer is configured', () => {
    const knownness = budgetKnownness({
      tokenUsage: makeUsage({ reviewerCacheRead: 1_000_000 }),
      totalTasks: 1,
      escalatedCount: 0,
      plannerTool: 'claude-code',
      implementerTool: 'ollama',
    });

    expect(knownness).toMatchObject({
      isKnown: true,
      hasUnknownPaidUsage: false,
      unknownReason: null,
    });
  });

  it('attributes reviewer usage to the reviewer identity when a reviewer is configured', () => {
    const knownness = budgetKnownness({
      tokenUsage: makeUsage({ reviewerCacheRead: 1_000_000 }),
      totalTasks: 1,
      escalatedCount: 0,
      plannerTool: 'claude-code',
      implementerTool: 'ollama',
      reviewerTool: 'custom-worker-api',
      reviewerModel: 'deepseek-v4-flash',
    });

    expect(knownness).toMatchObject({
      isKnown: false,
      hasUnknownPaidUsage: true,
      unknownReason: 'pricing unknown for custom-worker-api/deepseek-v4-flash',
    });
  });

  it('prices review spend exactly as planner spend when no reviewer is configured', () => {
    const base = {
      totalTasks: 2,
      escalatedCount: 1,
      plannerTool: 'custom-planner-api',
      plannerModel: 'claude-sonnet-5',
      implementerTool: 'ollama',
    };

    expect(
      budgetKnownness({
        ...base,
        tokenUsage: makeUsage({
          plannerInput: 900_000,
          plannerOutput: 100_000,
          reviewerInput: 100_000,
        }),
      }),
    ).toEqual(
      budgetKnownness({
        ...base,
        tokenUsage: makeUsage({ plannerInput: 1_000_000, plannerOutput: 100_000 }),
      }),
    );
  });
});
