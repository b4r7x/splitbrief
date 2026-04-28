import { describe, it, expect, vi } from 'vitest';
import type { TokenUsage } from '../../core/schemas/tokens.js';
import type { OrchestratorCallbacks } from './types.js';
import type { ModelCacheAccessor } from '../providers/model-resolution.js';
import { checkBudget, getCurrentCost, enforceBudget } from './budget.js';
import { makeCallbacks as makeSharedCallbacks, makeBusRecorder } from '#testing/helpers/orchestrator-factories.js';
import { taskId } from '../../core/schemas/task.js';

const zeroUsage: TokenUsage = {
  plannerInput: 0, plannerOutput: 0,
  implementerInput: 0, implementerOutput: 0,
  escalationInput: 0, escalationOutput: 0,
};

const emptyPricingCache: ModelCacheAccessor = {
  getModelsDevCatalog: () => null,
  getProviderModels: () => null,
};

function makeCallbacks(overrides?: Partial<OrchestratorCallbacks>): OrchestratorCallbacks {
  return makeSharedCallbacks({ ...overrides }).callbacks;
}

describe('checkBudget', () => {
  it('returns ok when cost is below 80% threshold', () => {
    expect(checkBudget(0.50, 1.00)).toEqual({ action: 'ok' });
  });

  it('returns ok at exactly 79%', () => {
    expect(checkBudget(0.79, 1.00)).toEqual({ action: 'ok' });
  });

  it('returns warning at 80% threshold', () => {
    expect(checkBudget(0.80, 1.00)).toEqual({ action: 'warning' });
  });

  it('returns warning between 80% and 85%', () => {
    expect(checkBudget(0.82, 1.00)).toEqual({ action: 'warning' });
  });

  it('returns paused at exactly 85%', () => {
    expect(checkBudget(0.85, 1.00)).toEqual({ action: 'paused' });
  });

  it('returns paused between 85% and 100%', () => {
    expect(checkBudget(0.95, 1.00)).toEqual({ action: 'paused' });
  });

  it('returns paused at custom pauseThreshold of 90%', () => {
    expect(checkBudget(0.90, 1.00, 0.90)).toEqual({ action: 'paused' });
  });

  it('returns warning at 85% when custom pauseThreshold is 90%', () => {
    expect(checkBudget(0.85, 1.00, 0.90)).toEqual({ action: 'warning' });
  });

  it('returns exceeded at 100%', () => {
    expect(checkBudget(1.00, 1.00)).toEqual({ action: 'exceeded', shouldStop: true });
  });

  it('returns exceeded over 100%', () => {
    expect(checkBudget(1.50, 1.00)).toEqual({ action: 'exceeded', shouldStop: true });
  });

  it('returns exceeded for NaN budget', () => {
    expect(checkBudget(0, NaN)).toEqual({ action: 'exceeded', shouldStop: true });
  });

  it('returns exceeded for zero budget', () => {
    expect(checkBudget(0, 0)).toEqual({ action: 'exceeded', shouldStop: true });
  });

  it('returns exceeded for negative budget', () => {
    expect(checkBudget(0, -1)).toEqual({ action: 'exceeded', shouldStop: true });
  });

  it('returns exceeded for Infinity budget', () => {
    expect(checkBudget(0, Infinity)).toEqual({ action: 'exceeded', shouldStop: true });
  });

  it('returns ok for NaN currentCost (safe default — do not block on bad data)', () => {
    expect(checkBudget(NaN, 1.00)).toEqual({ action: 'ok' });
  });

  it('returns exceeded for Infinity currentCost', () => {
    expect(checkBudget(Infinity, 1.00)).toEqual({ action: 'exceeded', shouldStop: true });
  });

  it('returns exceeded for negative Infinity currentCost', () => {
    expect(checkBudget(-Infinity, 1.00)).toEqual({ action: 'exceeded', shouldStop: true });
  });

  it('returns ok for negative currentCost (below threshold)', () => {
    expect(checkBudget(-0.50, 1.00)).toEqual({ action: 'ok' });
  });
});

describe('getCurrentCost', () => {
  it('returns 0 for zero usage with local tools', () => {
    expect(getCurrentCost({
      tokenUsage: zeroUsage,
      totalTasks: 1,
      escalatedCount: 0,
      plannerTool: 'ollama',
      implementerTool: 'ollama',
    })).toBe(0);
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
      getProviderModels: (providerId) => providerId === 'anthropic'
        ? [{
            id: 'claude-runtime-budget-only',
            pricingInput: 10,
            pricingOutput: 30,
          }]
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
        { taskId: taskId('T001'), taskTitle: 'local task', method: 'local', implementerTokens: 1_000_000, escalationTokens: 0, retryCount: 0, tool: 'ollama', model: 'qwen-local' },
        { taskId: taskId('T002'), taskTitle: 'paid task', method: 'local', implementerTokens: 1_000_000, escalationTokens: 0, retryCount: 0, tool: 'deepseek', model: 'deepseek-chat' },
      ],
    });

    expect(cost).toBeCloseTo(0.35, 10);
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
        { taskId: taskId('T001'), taskTitle: 'local task', method: 'local', implementerTokens: 1_000_000, escalationTokens: 0, retryCount: 0, tool: 'ollama', model: 'qwen-local' },
      ],
    });

    expect(cost).toBe(0);
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
      maxBudget: 1.00,
      callbacks: makeCallbacks(),
      bus,
      warningEmitted: false,
      pauseEmitted: false,
    });
    expect(result.stop).toBe(false);
    expect(result.warningEmitted).toBe(false);
  });

  it('emits warning at 80% and sets warningEmitted', async () => {
    const callbacks = makeCallbacks();
    const { bus, events } = makeBusRecorder();
    // Use an API-priced planner with enough tokens to hit ~82% (within warning zone [80%, 85%))
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
    const budget = cost / 0.82; // puts cost at ~82%, inside warning zone

    const result = await enforceBudget({
      ...baseOpts,
      plannerTool: 'anthropic',
      tokenUsage: usage,
      maxBudget: budget,
      callbacks,
      bus,
      warningEmitted: false,
      pauseEmitted: false,
    });

    expect(result.stop).toBe(false);
    expect(result.warningEmitted).toBe(true);
    expect(events.some(e => e.type === 'budget_warning')).toBe(true);
  });

  it('does not re-emit warning if already emitted', async () => {
    const callbacks = makeCallbacks();
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
    const budget = cost / 0.82; // puts cost at ~82%, inside warning zone

    const result = await enforceBudget({
      ...baseOpts,
      plannerTool: 'anthropic',
      tokenUsage: usage,
      maxBudget: budget,
      callbacks,
      bus,
      warningEmitted: true,
      pauseEmitted: false,
    });

    expect(result.stop).toBe(false);
    expect(events.some(e => e.type === 'budget_warning')).toBe(false);
  });

  it('stops workflow when budget exceeded and no callback', async () => {
    const callbacks = makeCallbacks();
    const { bus, events } = makeBusRecorder();
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
    const budget = cost * 0.5; // budget well below actual cost

    const result = await enforceBudget({
      ...baseOpts,
      plannerTool: 'anthropic',
      tokenUsage: usage,
      maxBudget: budget,
      callbacks,
      bus,
      warningEmitted: false,
      pauseEmitted: false,
    });

    expect(result.stop).toBe(true);
    expect(result.warningEmitted).toBe(true);
    expect(result.recovery?.reason).toBe('budget-exceeded');
    expect(events.some(e => e.type === 'budget_exceeded')).toBe(true);
  });

  it('does not continue past budget exceeded even when legacy callback would allow it', async () => {
    const budgetPromptArgs: Array<{ current: number; max: number }> = [];
    const onBudgetExceeded = vi.fn().mockImplementation(async (current: number, max: number) => {
      budgetPromptArgs.push({ current, max });
      return true;
    });
    const callbacks = makeCallbacks({ onBudgetExceeded });
    const { bus } = makeBusRecorder();
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

    const result = await enforceBudget({
      ...baseOpts,
      plannerTool: 'anthropic',
      tokenUsage: usage,
      maxBudget: budget,
      callbacks,
      bus,
      warningEmitted: false,
      pauseEmitted: false,
    });

    expect(onBudgetExceeded).not.toHaveBeenCalled();
    expect(budgetPromptArgs).toHaveLength(0);
    expect(result.stop).toBe(true);
    expect(result.recovery).toMatchObject({
      reason: 'budget-exceeded',
      maxBudget: budget,
    });
  });

  it('stops with budget exceeded recovery when legacy callback would abort', async () => {
    const budgetPromptArgs: Array<{ current: number; max: number }> = [];
    const onBudgetExceeded = vi.fn().mockImplementation(async (current: number, max: number) => {
      budgetPromptArgs.push({ current, max });
      return false;
    });
    const callbacks = makeCallbacks({ onBudgetExceeded });
    const { bus } = makeBusRecorder();
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

    const result = await enforceBudget({
      ...baseOpts,
      plannerTool: 'anthropic',
      tokenUsage: usage,
      maxBudget: budget,
      callbacks,
      bus,
      warningEmitted: false,
      pauseEmitted: false,
    });

    expect(onBudgetExceeded).not.toHaveBeenCalled();
    expect(budgetPromptArgs).toHaveLength(0);
    expect(result.stop).toBe(true);
    expect(result.recovery?.reason).toBe('budget-exceeded');
  });

  it('stops workflow when paused and no onBudgetPaused callback', async () => {
    const callbacks = makeCallbacks();
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
    const budget = cost / 0.87; // puts cost at ~87%, inside pause zone [85%, 100%)

    const result = await enforceBudget({
      ...baseOpts,
      plannerTool: 'anthropic',
      tokenUsage: usage,
      maxBudget: budget,
      callbacks,
      bus,
      warningEmitted: false,
      pauseEmitted: false,
    });

    expect(result.stop).toBe(true);
    expect(result.pauseEmitted).toBe(true);
    expect(result.recovery?.reason).toBe('budget-paused');
    expect(events.some(e => e.type === 'budget_paused')).toBe(true);
  });

  it('stops with budget pause recovery instead of invoking legacy continue callback', async () => {
    const onBudgetPaused = vi.fn().mockResolvedValue('continue' as const);
    const callbacks = makeCallbacks({ onBudgetPaused });
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
      callbacks,
      bus,
      warningEmitted: false,
      pauseEmitted: false,
    });

    expect(onBudgetPaused).not.toHaveBeenCalled();
    expect(result.stop).toBe(true);
    expect(result.pauseEmitted).toBe(true);
    expect(result.recovery).toMatchObject({ reason: 'budget-paused', threshold: 0.85 });
    expect(events.some(e => e.type === 'budget_paused')).toBe(true);
  });

  it('stops with budget pause recovery when legacy callback would abort', async () => {
    const onBudgetPaused = vi.fn().mockResolvedValue('abort' as const);
    const callbacks = makeCallbacks({ onBudgetPaused });
    const { bus } = makeBusRecorder();
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
      callbacks,
      bus,
      warningEmitted: false,
      pauseEmitted: false,
    });

    expect(onBudgetPaused).not.toHaveBeenCalled();
    expect(result.stop).toBe(true);
    expect(result.pauseEmitted).toBe(true);
    expect(result.recovery?.reason).toBe('budget-paused');
  });

  it('does not re-pause when pauseEmitted is true', async () => {
    const onBudgetPaused = vi.fn().mockResolvedValue('continue');
    const callbacks = makeCallbacks({ onBudgetPaused });
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
      callbacks,
      bus,
      warningEmitted: true,
      pauseEmitted: true,
    });

    expect(result.stop).toBe(false);
    expect(onBudgetPaused).not.toHaveBeenCalled();
    expect(events.some(e => e.type === 'budget_paused')).toBe(false);
  });

  it('publishes budget_paused event on first pause trigger', async () => {
    const onBudgetPaused = vi.fn().mockResolvedValue('continue' as const);
    const callbacks = makeCallbacks({ onBudgetPaused });
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

    await enforceBudget({
      ...baseOpts,
      plannerTool: 'anthropic',
      tokenUsage: usage,
      maxBudget: budget,
      callbacks,
      bus,
      warningEmitted: false,
      pauseEmitted: false,
    });

    const pauseEvent = events.find(e => e.type === 'budget_paused');
    expect(onBudgetPaused).not.toHaveBeenCalled();
    expect(pauseEvent).toBeDefined();
    expect(pauseEvent?.type === 'budget_paused' && pauseEvent.threshold).toBe(0.85);
  });

  it('stops for budget pause instead of treating legacy raise response as continue', async () => {
    const onBudgetPaused = vi.fn().mockResolvedValue('raise' as const);
    const callbacks = makeCallbacks({ onBudgetPaused });
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
      callbacks,
      bus,
      warningEmitted: false,
      pauseEmitted: false,
    });

    expect(onBudgetPaused).not.toHaveBeenCalled();
    expect(result.stop).toBe(true);
    expect(result.pauseEmitted).toBe(true);
    expect(result.recovery?.reason).toBe('budget-paused');
    expect(events.some(e => e.type === 'warning')).toBe(true);
  });

  it('emits budget_warning before budget_paused when crossing past 80% straight into pause zone', async () => {
    const onBudgetPaused = vi.fn().mockResolvedValue('continue' as const);
    const callbacks = makeCallbacks({ onBudgetPaused });
    const { bus, events } = makeBusRecorder();
    const usage: TokenUsage = {
      ...zeroUsage,
      plannerInput: 200_000,
      plannerOutput: 20_000,
    };
    const cost = getCurrentCost({ ...baseOpts, tokenUsage: usage, plannerTool: 'anthropic' });
    const budget = cost / 0.9; // 90% of budget — past warning, deep into pause zone

    await enforceBudget({
      ...baseOpts,
      plannerTool: 'anthropic',
      tokenUsage: usage,
      maxBudget: budget,
      callbacks,
      bus,
      warningEmitted: false,
      pauseEmitted: false,
    });

    const warningIdx = events.findIndex(e => e.type === 'budget_warning');
    const pausedIdx = events.findIndex(e => e.type === 'budget_paused');
    expect(warningIdx).toBeGreaterThanOrEqual(0);
    expect(pausedIdx).toBeGreaterThanOrEqual(0);
    expect(warningIdx).toBeLessThan(pausedIdx);
    expect(onBudgetPaused).not.toHaveBeenCalled();
  });

  it('emits budget_warning before budget_exceeded when crossing past 80% straight into exceeded zone', async () => {
    const callbacks = makeCallbacks();
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
      callbacks,
      bus,
      warningEmitted: false,
      pauseEmitted: false,
    });

    const warningIdx = events.findIndex(e => e.type === 'budget_warning');
    const exceededIdx = events.findIndex(e => e.type === 'budget_exceeded');
    expect(warningIdx).toBeGreaterThanOrEqual(0);
    expect(exceededIdx).toBeGreaterThanOrEqual(0);
    expect(warningIdx).toBeLessThan(exceededIdx);
  });

  it('uses plannerModel pricing in cost calculation (cheaper model => lower cost => no pause)', async () => {
    const callbacks = makeCallbacks();
    const { bus: busSonnet, events: eSonnet } = makeBusRecorder();
    const { bus: busHaiku, events: eHaiku } = makeBusRecorder();
    const usage: TokenUsage = {
      ...zeroUsage,
      plannerInput: 200_000,
      plannerOutput: 20_000,
    };
    // Same anthropic provider; sonnet ($3/$15) vs haiku-style cheaper unknown model => 0 cost.
    const sonnetCost = getCurrentCost({
      ...baseOpts, tokenUsage: usage, plannerTool: 'anthropic', plannerModel: 'claude-sonnet-4-6',
    });
    const unknownCost = getCurrentCost({
      ...baseOpts, tokenUsage: usage, plannerTool: 'anthropic', plannerModel: 'definitely-not-a-real-model-xyz',
    });
    expect(sonnetCost).toBeGreaterThan(0);
    // The unknown model resolves to unpriced — its cost is 0, so a tiny budget should not trip pause.
    expect(unknownCost).toBe(0);

    const sonnetResult = await enforceBudget({
      ...baseOpts,
      plannerTool: 'anthropic',
      plannerModel: 'claude-sonnet-4-6',
      tokenUsage: usage,
      maxBudget: sonnetCost / 0.9,
      callbacks,
      bus: busSonnet,
      warningEmitted: false,
      pauseEmitted: false,
    });
    const unknownResult = await enforceBudget({
      ...baseOpts,
      plannerTool: 'anthropic',
      plannerModel: 'definitely-not-a-real-model-xyz',
      tokenUsage: usage,
      maxBudget: sonnetCost / 0.9, // same budget
      callbacks,
      bus: busHaiku,
      warningEmitted: false,
      pauseEmitted: false,
    });

    expect(sonnetResult.pauseEmitted).toBe(true);
    expect(eSonnet.some(e => e.type === 'budget_paused')).toBe(true);
    expect(unknownResult.pauseEmitted).toBe(false);
    expect(eHaiku.some(e => e.type === 'budget_paused')).toBe(false);
  });

  it('pauses for a priced runtime-only selected model from the pricing cache', async () => {
    const callbacks = makeCallbacks({ onBudgetPaused: async () => 'abort' as const });
    const { bus, events } = makeBusRecorder();
    const pricingCache: ModelCacheAccessor = {
      ...emptyPricingCache,
      getProviderModels: (providerId) => providerId === 'anthropic'
        ? [{
            id: 'claude-runtime-budget-only',
            pricingInput: 10,
            pricingOutput: 30,
          }]
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
      callbacks,
      bus,
      warningEmitted: false,
      pauseEmitted: false,
    });

    expect(result.stop).toBe(true);
    expect(result.pauseEmitted).toBe(true);
    expect(events.map(e => e.type)).toEqual(expect.arrayContaining(['budget_warning', 'budget_paused']));
  });
});
