import { describe, expect, it } from 'vitest';
import type { CostBreakdown } from '../../../core/schemas/summary.js';
import {
  buildCostStatusLineLayout,
  formatBudget,
  formatCacheHitPct,
  type CostStatusLineLayoutInput,
} from './cost-chrome.js';

function breakdownWith(actualPlannerCost: number, actualImplementerCost: number): CostBreakdown {
  return {
    hypotheticalCost: 0,
    actualPlannerCost,
    actualImplementerCost,
    totalActualCost: actualPlannerCost + actualImplementerCost,
    savingsAmount: 0,
    savingsPercentage: 0,
    localCompletionRate: 0,
  };
}

function projectedText(
  overrides: Pick<
    CostStatusLineLayoutInput,
    'completedCount' | 'totalActualCost' | 'prediction' | 'totalTasks' | 'costBreakdown'
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
    ...overrides,
  });
  return layout.kind === 'single' ? layout.line : layout.left;
}

describe('projected cost via buildCostStatusLineLayout', () => {
  it('projects only the recurring implementer cost, not the one-time planner cost', () => {
    expect(
      projectedText({
        completedCount: 1,
        totalActualCost: 2.05,
        costBreakdown: breakdownWith(2.0, 0.05),
        prediction: null,
        totalTasks: 10,
      }),
    ).toBe('proj $2.50');
  });

  it('projects remaining implementer cost from a completed task', () => {
    expect(
      projectedText({
        completedCount: 2,
        totalActualCost: 2.0,
        costBreakdown: breakdownWith(1.0, 1.0),
        prediction: null,
        totalTasks: 4,
      }),
    ).toBe('proj $3.00');
  });

  it('falls back to total actual cost when no implementer cost breakdown exists', () => {
    expect(
      projectedText({
        completedCount: 2,
        totalActualCost: 2.0,
        costBreakdown: null,
        prediction: null,
        totalTasks: 4,
      }),
    ).toBe('proj $2.00');
  });

  it('falls back to the prediction when no task cost is available', () => {
    const prediction: NonNullable<CostStatusLineLayoutInput['prediction']> = {
      estimatedTasks: 4,
      lowCost: 1,
      expectedCost: 3.5,
      highCost: 6,
      plannerTool: 'x',
      implementerTool: 'y',
    };
    expect(
      projectedText({
        completedCount: 0,
        totalActualCost: 0,
        costBreakdown: null,
        prediction,
        totalTasks: 4,
      }),
    ).toBe('proj $3.50');
  });

  it('prefers deterministic known actual estimate over legacy expected prediction', () => {
    const prediction: NonNullable<CostStatusLineLayoutInput['prediction']> = {
      estimatedTasks: 4,
      lowCost: 1,
      expectedCost: 3.5,
      highCost: 6,
      plannerTool: 'x',
      implementerTool: 'y',
      deterministic: {
        estimateScope: 'prompt-input-only',
        taskCount: 4,
        taskFitCounts: { fits: 4, tight: 0, overflow: 0, unknown: 0 },
        contextConfidenceCounts: {
          contextExplicit: 4,
          contextDetected: 0,
          contextKnownCatalog: 0,
          contextCachedProvider: 0,
          contextConservativeFallback: 0,
          profileUnavailable: 0,
        },
        priceConfidenceCounts: {
          priceKnown: 4,
          priceUnknown: 0,
          profileUnavailable: 0,
        },
        tasks: [],
        totals: {
          knownActualEstimate: 0.42,
          hypotheticalAllPlanner: 2.5,
          estimatedSavings: 2.08,
          unknownCostReason: [],
        },
      },
    };
    expect(
      projectedText({
        completedCount: 0,
        totalActualCost: 0,
        costBreakdown: null,
        prediction,
        totalTasks: 4,
      }),
    ).toBe('proj $0.42');
  });

  it('reports unavailable projection when neither source exists', () => {
    expect(
      projectedText({
        completedCount: 0,
        totalActualCost: 0,
        costBreakdown: null,
        prediction: null,
        totalTasks: 4,
      }),
    ).toBe('');
  });

  it('omits unavailable spend and projection labels from the status line', () => {
    const layout = buildCostStatusLineLayout({
      renderWidth: 120,
      paddingX: 0,
      spentText: 'n/a',
      completedCount: 0,
      totalActualCost: 0,
      prediction: null,
      totalTasks: 4,
      pricingState: 'n/a',
      maxBudget: undefined,
      plannerInput: 0,
      totalInput: 0,
      totalCacheRead: 0,
      localRate: 0,
      routedTasks: 0,
      costBreakdown: null,
    });
    const text = layout.kind === 'single' ? layout.line : `${layout.left} ${layout.right}`;

    expect(text).not.toContain('spent n/a');
    expect(text).not.toContain('proj n/a');
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
    [500, 0, 'cache 100%'],
    [1, 2, 'cache 33%'],
    [500, 500, 'cache 50%'],
  ] as const)('formats cache read %s with input %i as %s', (cacheRead, input, expected) => {
    expect(formatCacheHitPct(cacheRead, input)).toBe(expected);
  });
});
