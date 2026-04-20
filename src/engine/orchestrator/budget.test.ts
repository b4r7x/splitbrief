import { describe, it, expect } from 'vitest';
import type { TokenUsage } from '../../core/schemas/tokens.js';
import type { OrchestratorCallbacks } from './types.js';
import { checkBudget, getCurrentCost, enforceBudget } from './budget.js';
import { makeCallbacks as makeSharedCallbacks, makeBusRecorder } from '#testing/helpers/orchestrator-factories.js';

const zeroUsage: TokenUsage = {
  plannerInput: 0, plannerOutput: 0,
  implementerInput: 0, implementerOutput: 0,
  escalationInput: 0, escalationOutput: 0,
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

  it('returns warning between 80% and 100%', () => {
    expect(checkBudget(0.95, 1.00)).toEqual({ action: 'warning' });
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
    });
    expect(result.stop).toBe(false);
    expect(result.warningEmitted).toBe(false);
  });

  it('emits warning at 80% and sets warningEmitted', async () => {
    const callbacks = makeCallbacks();
    const { bus, events } = makeBusRecorder();
    // Use an API-priced planner with enough tokens to hit 80%
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
    const budget = cost / 0.85; // make sure we're at ~85%

    const result = await enforceBudget({
      ...baseOpts,
      plannerTool: 'anthropic',
      tokenUsage: usage,
      maxBudget: budget,
      callbacks,
      bus,
      warningEmitted: false,
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
    const budget = cost / 0.85;

    const result = await enforceBudget({
      ...baseOpts,
      plannerTool: 'anthropic',
      tokenUsage: usage,
      maxBudget: budget,
      callbacks,
      bus,
      warningEmitted: true,
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
    });

    expect(result.stop).toBe(true);
    expect(result.warningEmitted).toBe(true);
    expect(events.some(e => e.type === 'budget_exceeded')).toBe(true);
  });

  it('asks onBudgetExceeded callback when provided and continues if true', async () => {
    const budgetPromptArgs: Array<{ current: number; max: number }> = [];
    const onBudgetExceeded = async (current: number, max: number) => {
      budgetPromptArgs.push({ current, max });
      return true;
    };
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
    });

    // Observable: the prompt was delivered to the user callback with the
    // realised cost/budget, and the user's "continue" answer propagated.
    expect(budgetPromptArgs).toHaveLength(1);
    expect(budgetPromptArgs[0]?.current).toBeGreaterThan(budget);
    expect(budgetPromptArgs[0]?.max).toBe(budget);
    expect(result.stop).toBe(false);
  });

  it('stops when onBudgetExceeded callback returns false', async () => {
    const budgetPromptArgs: Array<{ current: number; max: number }> = [];
    const onBudgetExceeded = async (current: number, max: number) => {
      budgetPromptArgs.push({ current, max });
      return false;
    };
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
    });

    expect(budgetPromptArgs).toHaveLength(1);
    expect(result.stop).toBe(true);
  });
});
