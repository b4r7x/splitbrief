import { describe, it, expect } from 'vitest';
import type { TokenUsage } from '../../../core/schemas/tokens.js';
import type { ModelCacheAccessor } from '../../providers/model/resolution.js';
import { checkBudget, getBudgetCostKnownness, getCurrentCost, enforceBudget } from './check.js';
import { makeBusRecorder } from '#testing/helpers/orchestrator-factories.js';
import { taskId } from '../../../core/schemas/task.js';
import { protectEngineEventForConsumer } from '../../events/protection.js';

const zeroUsage: TokenUsage = {
  plannerInput: 0,
  plannerOutput: 0,
  implementerInput: 0,
  implementerOutput: 0,
  escalationInput: 0,
  escalationOutput: 0,
};

const emptyPricingCache: ModelCacheAccessor = {
  getModelsDevCatalog: () => null,
  getProviderModels: () => null,
};

describe('checkBudget', () => {
  it.each<[string, number, number, number | undefined, ReturnType<typeof checkBudget>]>([
    ['cost below 80%', 0.5, 1.0, undefined, { action: 'ok' }],
    ['cost at exactly 79%', 0.79, 1.0, undefined, { action: 'ok' }],
    ['NaN currentCost (safe default)', NaN, 1.0, undefined, { action: 'ok' }],
    ['negative currentCost', -0.5, 1.0, undefined, { action: 'ok' }],
  ])('ok — %s', (_label, cost, budget, pause, expected) => {
    expect(checkBudget(cost, budget, pause)).toEqual(expected);
  });

  it.each<[string, number, number, number | undefined, ReturnType<typeof checkBudget>]>([
    ['at 80% threshold', 0.8, 1.0, undefined, { action: 'warning' }],
    ['between 80% and 85%', 0.82, 1.0, undefined, { action: 'warning' }],
    ['at 85% with custom pauseThreshold 90%', 0.85, 1.0, 0.9, { action: 'warning' }],
  ])('warning — %s', (_label, cost, budget, pause, expected) => {
    expect(checkBudget(cost, budget, pause)).toEqual(expected);
  });

  it.each<[string, number, number, number | undefined, ReturnType<typeof checkBudget>]>([
    ['at exactly 85%', 0.85, 1.0, undefined, { action: 'paused' }],
    ['between 85% and 100%', 0.95, 1.0, undefined, { action: 'paused' }],
    ['at custom pauseThreshold 90%', 0.9, 1.0, 0.9, { action: 'paused' }],
  ])('paused — %s', (_label, cost, budget, pause, expected) => {
    expect(checkBudget(cost, budget, pause)).toEqual(expected);
  });

  it.each<[string, number, number, number | undefined, ReturnType<typeof checkBudget>]>([
    ['at 100%', 1.0, 1.0, undefined, { action: 'exceeded', shouldStop: true }],
    ['over 100%', 1.5, 1.0, undefined, { action: 'exceeded', shouldStop: true }],
    ['NaN budget', 0, NaN, undefined, { action: 'exceeded', shouldStop: true }],
    ['zero budget', 0, 0, undefined, { action: 'exceeded', shouldStop: true }],
    ['negative budget', 0, -1, undefined, { action: 'exceeded', shouldStop: true }],
    ['Infinity budget', 0, Infinity, undefined, { action: 'exceeded', shouldStop: true }],
    ['Infinity currentCost', Infinity, 1.0, undefined, { action: 'exceeded', shouldStop: true }],
    [
      'negative Infinity currentCost',
      -Infinity,
      1.0,
      undefined,
      { action: 'exceeded', shouldStop: true },
    ],
  ])('exceeded — %s', (_label, cost, budget, pause, expected) => {
    expect(checkBudget(cost, budget, pause)).toEqual(expected);
  });
});

describe('getCurrentCost', () => {
  it('returns 0 for zero usage with local tools', () => {
    expect(
      getCurrentCost({
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
    const cost = getCurrentCost({
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

    const withoutCache = getCurrentCost({
      tokenUsage: usage,
      totalTasks: 1,
      escalatedCount: 0,
      plannerTool: 'anthropic',
      plannerModel: 'claude-runtime-budget-only',
      implementerTool: 'ollama',
    });
    const withCache = getCurrentCost({
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

    const cost = getCurrentCost({
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
          model: 'deepseek-chat',
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
        model: 'claude-sonnet-4-6',
      },
    ];

    const cost = getCurrentCost({
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

    expect(cost).toBeCloseTo(0.3, 10);
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
          model: 'deepseek-chat',
        },
      ],
    });

    expect(knownness).toMatchObject({
      currentKnownCost: 0,
      isKnown: false,
      hasUnknownPaidUsage: true,
      hasLocalOnlyUnpricedUsage: false,
      unknownReason: 'pricing unknown for deepseek/deepseek-chat',
    });
  });

  it('does not charge local profile tokens at the global paid implementer rate', () => {
    const usage: TokenUsage = {
      ...zeroUsage,
      implementerInput: 500_000,
      implementerOutput: 500_000,
    };

    const cost = getCurrentCost({
      tokenUsage: usage,
      totalTasks: 1,
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

    const below = getCurrentCost({
      tokenUsage: { ...zeroUsage, plannerInput: 200_000 },
      totalTasks: 1,
      escalatedCount: 0,
      plannerTool: 'openai',
      plannerModel: 'gpt-5.4',
      implementerTool: 'ollama',
      pricingCache,
    });
    const above = getCurrentCost({
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
});

describe('enforceBudget', () => {
  const baseOpts = {
    totalTasks: 5,
    escalatedCount: 0,
    plannerTool: 'ollama',
    implementerTool: 'ollama',
  };

  it('returns stop=false for cost under threshold', async () => {
    const { bus } = makeBusRecorder();
    const result = await enforceBudget({
      ...baseOpts,
      tokenUsage: zeroUsage,
      maxBudget: 1.0,
      bus,
      warningEmitted: false,
      pauseEmitted: false,
    });
    expect(result.stop).toBe(false);
    expect(result.warningEmitted).toBe(false);
  });

  it('emits warning at 80% and sets warningEmitted', async () => {
    const { bus, events } = makeBusRecorder();
    const usage: TokenUsage = {
      ...zeroUsage,
      plannerInput: 200_000,
      plannerOutput: 20_000,
    };
    const cost = getCurrentCost({
      ...baseOpts,
      tokenUsage: usage,
      plannerTool: 'anthropic',
    });
    const budget = cost / 0.82;

    const result = await enforceBudget({
      ...baseOpts,
      plannerTool: 'anthropic',
      tokenUsage: usage,
      maxBudget: budget,
      bus,
      warningEmitted: false,
      pauseEmitted: false,
    });

    expect(result.stop).toBe(false);
    expect(result.warningEmitted).toBe(true);
    expect(events.some((e) => e.type === 'budget_warning')).toBe(true);
    const warning = events.find((e) => e.type === 'warning');
    expect(warning).toMatchObject({
      type: 'warning',
      category: 'budget',
      code: 'warning_threshold_reached',
      transcriptSafe: true,
    });
    expect(
      warning === undefined
        ? null
        : protectEngineEventForConsumer(warning, {
            context: 'session-log',
            persistTranscript: false,
          }),
    ).toMatchObject({
      type: 'warning',
      category: 'budget',
      code: 'warning_threshold_reached',
      message: expect.stringContaining('Budget 80% reached:'),
    });
  });

  it('does not re-emit warning if already emitted', async () => {
    const { bus, events } = makeBusRecorder();
    const usage: TokenUsage = {
      ...zeroUsage,
      plannerInput: 200_000,
      plannerOutput: 20_000,
    };
    const cost = getCurrentCost({
      ...baseOpts,
      tokenUsage: usage,
      plannerTool: 'anthropic',
    });
    const budget = cost / 0.82;

    const result = await enforceBudget({
      ...baseOpts,
      plannerTool: 'anthropic',
      tokenUsage: usage,
      maxBudget: budget,
      bus,
      warningEmitted: true,
      pauseEmitted: false,
    });

    expect(result.stop).toBe(false);
    expect(events.some((e) => e.type === 'budget_warning')).toBe(false);
  });

  it('stops with a budget-exceeded recovery boundary and emits budget_exceeded', async () => {
    const usage: TokenUsage = {
      ...zeroUsage,
      plannerInput: 1_000_000,
      plannerOutput: 100_000,
    };
    const cost = getCurrentCost({
      ...baseOpts,
      tokenUsage: usage,
      plannerTool: 'anthropic',
    });
    const budget = cost * 0.5;
    const { bus, events } = makeBusRecorder();

    const result = await enforceBudget({
      ...baseOpts,
      plannerTool: 'anthropic',
      tokenUsage: usage,
      maxBudget: budget,
      bus,
      warningEmitted: false,
      pauseEmitted: false,
    });

    expect(result.stop).toBe(true);
    expect(result.warningEmitted).toBe(true);
    expect(result.recovery).toMatchObject({
      reason: 'budget-exceeded',
      maxBudget: budget,
    });
    expect(events.some((e) => e.type === 'budget_exceeded')).toBe(true);
  });

  it('stops with a budget-paused recovery boundary and emits budget_paused', async () => {
    const usage: TokenUsage = {
      ...zeroUsage,
      plannerInput: 200_000,
      plannerOutput: 20_000,
    };
    const cost = getCurrentCost({
      ...baseOpts,
      tokenUsage: usage,
      plannerTool: 'anthropic',
    });
    const budget = cost / 0.87;
    const { bus, events } = makeBusRecorder();

    const result = await enforceBudget({
      ...baseOpts,
      plannerTool: 'anthropic',
      tokenUsage: usage,
      maxBudget: budget,
      bus,
      warningEmitted: false,
      pauseEmitted: false,
    });

    expect(result.stop).toBe(true);
    expect(result.pauseEmitted).toBe(true);
    expect(result.recovery).toMatchObject({ reason: 'budget-paused', threshold: 0.85 });
    expect(events.find((e) => e.type === 'budget_paused')).toMatchObject({ threshold: 0.85 });
    expect(events.some((e) => e.type === 'warning')).toBe(true);
  });

  it('does not re-pause when pauseEmitted is true', async () => {
    const { bus, events } = makeBusRecorder();
    const usage: TokenUsage = {
      ...zeroUsage,
      plannerInput: 200_000,
      plannerOutput: 20_000,
    };
    const cost = getCurrentCost({
      ...baseOpts,
      tokenUsage: usage,
      plannerTool: 'anthropic',
    });
    const budget = cost / 0.87;

    const result = await enforceBudget({
      ...baseOpts,
      plannerTool: 'anthropic',
      tokenUsage: usage,
      maxBudget: budget,
      bus,
      warningEmitted: true,
      pauseEmitted: true,
    });

    expect(result.stop).toBe(false);
    expect(events.some((e) => e.type === 'budget_paused')).toBe(false);
  });

  it('emits budget_warning before budget_paused when crossing past 80% straight into pause zone', async () => {
    const { bus, events } = makeBusRecorder();
    const usage: TokenUsage = {
      ...zeroUsage,
      plannerInput: 200_000,
      plannerOutput: 20_000,
    };
    const cost = getCurrentCost({ ...baseOpts, tokenUsage: usage, plannerTool: 'anthropic' });
    const budget = cost / 0.9;

    await enforceBudget({
      ...baseOpts,
      plannerTool: 'anthropic',
      tokenUsage: usage,
      maxBudget: budget,
      bus,
      warningEmitted: false,
      pauseEmitted: false,
    });

    const warningIdx = events.findIndex((e) => e.type === 'budget_warning');
    const pausedIdx = events.findIndex((e) => e.type === 'budget_paused');
    expect(warningIdx).toBeGreaterThanOrEqual(0);
    expect(pausedIdx).toBeGreaterThanOrEqual(0);
    expect(warningIdx).toBeLessThan(pausedIdx);
  });

  it('emits budget_warning before budget_exceeded when crossing past 80% straight into exceeded zone', async () => {
    const { bus, events } = makeBusRecorder();
    const usage: TokenUsage = {
      ...zeroUsage,
      plannerInput: 1_000_000,
      plannerOutput: 100_000,
    };
    const cost = getCurrentCost({ ...baseOpts, tokenUsage: usage, plannerTool: 'anthropic' });
    const budget = cost * 0.5;

    await enforceBudget({
      ...baseOpts,
      plannerTool: 'anthropic',
      tokenUsage: usage,
      maxBudget: budget,
      bus,
      warningEmitted: false,
      pauseEmitted: false,
    });

    const warningIdx = events.findIndex((e) => e.type === 'budget_warning');
    const exceededIdx = events.findIndex((e) => e.type === 'budget_exceeded');
    expect(warningIdx).toBeGreaterThanOrEqual(0);
    expect(exceededIdx).toBeGreaterThanOrEqual(0);
    expect(warningIdx).toBeLessThan(exceededIdx);
  });

  it('uses plannerModel pricing in cost calculation and pauses when paid model pricing is unknown', async () => {
    const { bus: busSonnet, events: eSonnet } = makeBusRecorder();
    const { bus: busHaiku, events: eHaiku } = makeBusRecorder();
    const usage: TokenUsage = {
      ...zeroUsage,
      plannerInput: 200_000,
      plannerOutput: 20_000,
    };
    const sonnetCost = getCurrentCost({
      ...baseOpts,
      tokenUsage: usage,
      plannerTool: 'anthropic',
      plannerModel: 'claude-sonnet-4-6',
    });
    const unknownCost = getCurrentCost({
      ...baseOpts,
      tokenUsage: usage,
      plannerTool: 'anthropic',
      plannerModel: 'definitely-not-a-real-model-xyz',
    });
    expect(sonnetCost).toBeGreaterThan(0);
    expect(unknownCost).toBe(0);

    const sonnetResult = await enforceBudget({
      ...baseOpts,
      plannerTool: 'anthropic',
      plannerModel: 'claude-sonnet-4-6',
      tokenUsage: usage,
      maxBudget: sonnetCost / 0.9,
      bus: busSonnet,
      warningEmitted: false,
      pauseEmitted: false,
    });
    const unknownResult = await enforceBudget({
      ...baseOpts,
      plannerTool: 'anthropic',
      plannerModel: 'definitely-not-a-real-model-xyz',
      tokenUsage: usage,
      maxBudget: sonnetCost / 0.9,
      bus: busHaiku,
      warningEmitted: false,
      pauseEmitted: false,
    });

    expect(sonnetResult.pauseEmitted).toBe(true);
    expect(eSonnet.some((e) => e.type === 'budget_paused')).toBe(true);
    expect(unknownResult.stop).toBe(true);
    expect(unknownResult.pauseEmitted).toBe(true);
    expect(eHaiku.some((e) => e.type === 'budget_paused')).toBe(true);
    expect(eHaiku.find((e) => e.type === 'warning')).toMatchObject({
      category: 'budget',
      code: 'tracking_paused',
      transcriptSafe: true,
      message:
        'Budget tracking paused: pricing unknown for anthropic/definitely-not-a-real-model-xyz; configure pricing or continue acknowledging unknown spend.',
    });
  });

  it('does not pause local-only usage purely because it is unpriced', async () => {
    const { bus, events } = makeBusRecorder();
    const result = await enforceBudget({
      ...baseOpts,
      tokenUsage: {
        ...zeroUsage,
        plannerInput: 100_000,
        implementerInput: 1_000_000,
      },
      maxBudget: 1,
      bus,
      warningEmitted: false,
      pauseEmitted: false,
    });

    expect(result.stop).toBe(false);
    expect(result.pauseEmitted).toBe(false);
    expect(events.some((e) => e.type === 'budget_paused')).toBe(false);
  });

  it('pauses for a priced runtime-only selected model from the pricing cache', async () => {
    const { bus, events } = makeBusRecorder();
    const pricingCache: ModelCacheAccessor = {
      ...emptyPricingCache,
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

    const result = await enforceBudget({
      ...baseOpts,
      plannerTool: 'anthropic',
      plannerModel: 'claude-runtime-budget-only',
      tokenUsage: usage,
      maxBudget: 40 / 0.9,
      pricingCache,
      bus,
      warningEmitted: false,
      pauseEmitted: false,
    });

    expect(result.stop).toBe(true);
    expect(result.pauseEmitted).toBe(true);
    expect(events.map((e) => e.type)).toEqual(
      expect.arrayContaining(['budget_warning', 'budget_paused']),
    );
  });
});
