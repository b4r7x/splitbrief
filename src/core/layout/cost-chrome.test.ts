import { describe, expect, it } from 'vitest';
import {
  formatBudget,
  formatCacheHitPct,
  formatProjected,
} from './cost-chrome.js';

describe('formatProjected', () => {
  it('uses completed-task cost when available', () => {
    expect(formatProjected(2, 2.0, null, 4)).toBe('proj $4.00');
  });

  it('falls back to the prediction when no task cost is available', () => {
    const prediction = { estimatedTasks: 4, lowCost: 1, expectedCost: 3.5, highCost: 6, plannerTool: 'x', implementerTool: 'y' };
    expect(formatProjected(0, 0, prediction, 4)).toBe('proj $3.50');
  });

  it('reports unavailable projection when neither source exists', () => {
    expect(formatProjected(0, 0, null, 4)).toBe('proj n/a');
  });
});

describe('formatBudget', () => {
  it('formats a configured budget and omits absent budgets', () => {
    expect(formatBudget(undefined)).toBe('');
    expect(formatBudget(10)).toBe('$10.00');
    expect(formatBudget(0.5)).toBe('$0.50');
  });
});

describe('formatCacheHitPct', () => {
  it.each([
    [undefined, 1000, 'cache n/a'],
    [0, 0, 'cache n/a'],
    [0, 1000, 'cache n/a'],
    [1, 2, 'cache 33%'],
    [500, 500, 'cache 50%'],
  ] as const)('formats cache read %s with input %i as %s', (cacheRead, input, expected) => {
    expect(formatCacheHitPct(cacheRead, input)).toBe(expected);
  });
});
