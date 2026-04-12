import { describe, it, expect, vi } from 'vitest';
import type { TokenUsage, OrchestratorCallbacks } from '../../types.js';
import { checkBudget, getCurrentCost, enforceBudget } from './budget.js';

const zeroUsage: TokenUsage = {
  plannerInput: 0, plannerOutput: 0,
  implementerInput: 0, implementerOutput: 0,
  escalationInput: 0, escalationOutput: 0,
};

function makeCallbacks(overrides?: Partial<OrchestratorCallbacks>): OrchestratorCallbacks {
  return {
    onEvent: vi.fn(),
    onApprovalNeeded: vi.fn().mockResolvedValue({ approved: true }),
    onExternalChanges: vi.fn().mockResolvedValue(false),
    onComplete: vi.fn(),
    ...overrides,
  };
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

  it('returns positive cost for non-local tools', () => {
    const usage: TokenUsage = {
      ...zeroUsage,
      plannerInput: 1_000_000,
      plannerOutput: 100_000,
    };
    const cost = getCurrentCost({
      tokenUsage: usage,
      totalTasks: 1,
      escalatedCount: 0,
      plannerTool: 'claude-code',
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
    const result = await enforceBudget({
      ...baseOpts,
      tokenUsage: zeroUsage,
      maxBudget: 1.00,
      callbacks: makeCallbacks(),
      warningEmitted: false,
    });
    expect(result.stop).toBe(false);
    expect(result.warningEmitted).toBe(false);
  });

  it('emits warning at 80% and sets warningEmitted', async () => {
    const callbacks = makeCallbacks();
    // Use claude-code planner with enough tokens to hit 80%
    const usage: TokenUsage = {
      ...zeroUsage,
      plannerInput: 200_000,
      plannerOutput: 20_000,
    };
    const cost = getCurrentCost({ ...baseOpts, tokenUsage: usage, plannerTool: 'claude-code' });
    const budget = cost / 0.85; // make sure we're at ~85%

    const result = await enforceBudget({
      ...baseOpts,
      plannerTool: 'claude-code',
      tokenUsage: usage,
      maxBudget: budget,
      callbacks,
      warningEmitted: false,
    });

    expect(result.stop).toBe(false);
    expect(result.warningEmitted).toBe(true);
    const events = vi.mocked(callbacks.onEvent).mock.calls.map(c => c[0]);
    expect(events.some(e => e.type === 'budget-warning')).toBe(true);
  });

  it('does not re-emit warning if already emitted', async () => {
    const callbacks = makeCallbacks();
    const usage: TokenUsage = {
      ...zeroUsage,
      plannerInput: 200_000,
      plannerOutput: 20_000,
    };
    const cost = getCurrentCost({ ...baseOpts, tokenUsage: usage, plannerTool: 'claude-code' });
    const budget = cost / 0.85;

    const result = await enforceBudget({
      ...baseOpts,
      plannerTool: 'claude-code',
      tokenUsage: usage,
      maxBudget: budget,
      callbacks,
      warningEmitted: true,
    });

    expect(result.stop).toBe(false);
    const events = vi.mocked(callbacks.onEvent).mock.calls.map(c => c[0]);
    expect(events.some(e => e.type === 'budget-warning')).toBe(false);
  });

  it('stops workflow when budget exceeded and no callback', async () => {
    const callbacks = makeCallbacks();
    const usage: TokenUsage = {
      ...zeroUsage,
      plannerInput: 1_000_000,
      plannerOutput: 100_000,
    };
    const cost = getCurrentCost({ ...baseOpts, tokenUsage: usage, plannerTool: 'claude-code' });
    const budget = cost * 0.5; // budget well below actual cost

    const result = await enforceBudget({
      ...baseOpts,
      plannerTool: 'claude-code',
      tokenUsage: usage,
      maxBudget: budget,
      callbacks,
      warningEmitted: false,
    });

    expect(result.stop).toBe(true);
    expect(result.warningEmitted).toBe(true);
    const events = vi.mocked(callbacks.onEvent).mock.calls.map(c => c[0]);
    expect(events.some(e => e.type === 'budget-exceeded')).toBe(true);
  });

  it('asks onBudgetExceeded callback when provided and continues if true', async () => {
    const onBudgetExceeded = vi.fn().mockResolvedValue(true);
    const callbacks = makeCallbacks({ onBudgetExceeded });
    const usage: TokenUsage = {
      ...zeroUsage,
      plannerInput: 1_000_000,
      plannerOutput: 100_000,
    };
    const cost = getCurrentCost({ ...baseOpts, tokenUsage: usage, plannerTool: 'claude-code' });
    const budget = cost * 0.5;

    const result = await enforceBudget({
      ...baseOpts,
      plannerTool: 'claude-code',
      tokenUsage: usage,
      maxBudget: budget,
      callbacks,
      warningEmitted: false,
    });

    expect(onBudgetExceeded).toHaveBeenCalled();
    expect(result.stop).toBe(false);
  });

  it('stops when onBudgetExceeded callback returns false', async () => {
    const onBudgetExceeded = vi.fn().mockResolvedValue(false);
    const callbacks = makeCallbacks({ onBudgetExceeded });
    const usage: TokenUsage = {
      ...zeroUsage,
      plannerInput: 1_000_000,
      plannerOutput: 100_000,
    };
    const cost = getCurrentCost({ ...baseOpts, tokenUsage: usage, plannerTool: 'claude-code' });
    const budget = cost * 0.5;

    const result = await enforceBudget({
      ...baseOpts,
      plannerTool: 'claude-code',
      tokenUsage: usage,
      maxBudget: budget,
      callbacks,
      warningEmitted: false,
    });

    expect(onBudgetExceeded).toHaveBeenCalled();
    expect(result.stop).toBe(true);
  });
});
