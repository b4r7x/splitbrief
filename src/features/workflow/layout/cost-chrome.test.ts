import { describe, expect, it } from 'vitest';
import {
  buildCostStatusLineLayout,
  formatBudget,
  formatCacheHitPct,
  type CostStatusLineLayoutInput,
} from './cost-chrome.js';

function projectedText(
  overrides: Pick<
    CostStatusLineLayoutInput,
    'completedCount' | 'totalActualCost' | 'prediction' | 'totalTasks'
  >,
): string {
  const layout = buildCostStatusLineLayout({
    renderWidth: 120,
    paddingX: 0,
    spentText: '',
    pricingState: 'priced',
    maxBudget: undefined,
    plannerInput: 0,
    totalInput: 0,
    totalCacheRead: 0,
    localRate: 0,
    routedTasks: 0,
    costBreakdown: null,
    ...overrides,
  });
  return layout.kind === 'single' ? layout.line : layout.left;
}

describe('projected cost via buildCostStatusLineLayout', () => {
  it('uses completed-task cost when available', () => {
    expect(
      projectedText({ completedCount: 2, totalActualCost: 2.0, prediction: null, totalTasks: 4 }),
    ).toBe('proj $4.00');
  });

  it('falls back to the prediction when no task cost is available', () => {
    const prediction = {
      estimatedTasks: 4,
      lowCost: 1,
      expectedCost: 3.5,
      highCost: 6,
      plannerTool: 'x',
      implementerTool: 'y',
    };
    expect(
      projectedText({ completedCount: 0, totalActualCost: 0, prediction, totalTasks: 4 }),
    ).toBe('proj $3.50');
  });

  it('reports unavailable projection when neither source exists', () => {
    expect(
      projectedText({ completedCount: 0, totalActualCost: 0, prediction: null, totalTasks: 4 }),
    ).toBe('proj n/a');
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
