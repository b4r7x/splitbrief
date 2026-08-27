import { describe, it, expect } from 'vitest';
import type { TokenUsage } from '../../../core/schemas/tokens.js';
import type { ModelCacheAccessor } from '../../providers/model/resolution.js';
import { getBudgetCostKnownness } from './knownness.js';
import { taskId } from '../../../core/schemas/task.js';
import { makeUsage } from '#testing/helpers/factories/summary.js';

const zeroUsage = makeUsage();

function currentKnownCost(opts: Parameters<typeof getBudgetCostKnownness>[0]): number {
  return getBudgetCostKnownness(opts).currentKnownCost;
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

  it('returns positive cost for API-priced providers', () => {
    const usage: TokenUsage = {
      ...zeroUsage,
      plannerInput: 1_000_000,
      plannerOutput: 100_000,
    };
    const cost = currentKnownCost({
      tokenUsage: usage,
      totalTasks: 1,
      escalatedCount: 0,
      plannerTool: 'anthropic',
      implementerTool: 'ollama',
    });
    expect(cost).toBeGreaterThan(0);
  });

  it('uses runtime-only model cache pricing when calculating current cost', () => {
    const pricingCache: ModelCacheAccessor = {
      getModelsDevCatalog: () => null,
      getProviderModels: (providerId) =>
        providerId === 'anthropic'
          ? [
              {
                id: 'claude-runtime-budget-only',
                pricingInput: 10,
                pricingOutput: 30,
              },
            ]
          : null,
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
      plannerTool: 'anthropic',
      plannerModel: 'claude-runtime-budget-only',
      implementerTool: 'ollama',
    });
    const withCache = currentKnownCost({
      tokenUsage: usage,
      totalTasks: 1,
      escalatedCount: 0,
      plannerTool: 'anthropic',
      plannerModel: 'claude-runtime-budget-only',
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
          tool: 'deepseek',
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
        tool: 'anthropic',
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
    const knownness = getBudgetCostKnownness({
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

    const knownness = getBudgetCostKnownness({
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
          tool: 'deepseek',
          model: 'deepseek-v4-flash',
        },
      ],
    });

    expect(knownness).toMatchObject({
      currentKnownCost: 0,
      isKnown: false,
      hasUnknownPaidUsage: true,
      hasLocalOnlyUnpricedUsage: false,
      unknownReason: 'pricing unknown for deepseek/deepseek-v4-flash',
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

    const knownness = getBudgetCostKnownness({
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
      plannerTool: 'openai',
      plannerModel: 'gpt-5.4',
      implementerTool: 'ollama',
      pricingCache,
    });
    const above = currentKnownCost({
      tokenUsage: { ...zeroUsage, plannerInput: 300_000 },
      totalTasks: 1,
      escalatedCount: 0,
      plannerTool: 'openai',
      plannerModel: 'gpt-5.4',
      implementerTool: 'ollama',
      pricingCache,
    });

    expect(below).toBeCloseTo(0.5, 10);
    expect(above).toBeCloseTo(1.5, 10);
  });

  it('attributes reviewer usage to the planner identity when no reviewer is configured', () => {
    const knownness = getBudgetCostKnownness({
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
    const knownness = getBudgetCostKnownness({
      tokenUsage: makeUsage({ reviewerCacheRead: 1_000_000 }),
      totalTasks: 1,
      escalatedCount: 0,
      plannerTool: 'claude-code',
      implementerTool: 'ollama',
      reviewerTool: 'deepseek',
      reviewerModel: 'deepseek-v4-flash',
    });

    expect(knownness).toMatchObject({
      isKnown: false,
      hasUnknownPaidUsage: true,
      unknownReason: 'pricing unknown for deepseek/deepseek-v4-flash',
    });
  });

  it('prices review spend exactly as planner spend when no reviewer is configured', () => {
    const base = {
      totalTasks: 2,
      escalatedCount: 1,
      plannerTool: 'anthropic',
      plannerModel: 'claude-sonnet-5',
      implementerTool: 'ollama',
    };

    expect(
      getBudgetCostKnownness({
        ...base,
        tokenUsage: makeUsage({
          plannerInput: 900_000,
          plannerOutput: 100_000,
          reviewerInput: 100_000,
        }),
      }),
    ).toEqual(
      getBudgetCostKnownness({
        ...base,
        tokenUsage: makeUsage({ plannerInput: 1_000_000, plannerOutput: 100_000 }),
      }),
    );
  });
});
