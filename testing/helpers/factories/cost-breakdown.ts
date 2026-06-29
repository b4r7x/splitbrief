import type { CostBreakdown } from '../../../src/core/schemas/summary.js';

export function makeCostBreakdown(overrides: Partial<CostBreakdown> = {}): CostBreakdown {
  return {
    hypotheticalCost: 0,
    actualPlannerCost: 0,
    actualImplementerCost: 0,
    totalActualCost: 0,
    savingsAmount: 0,
    savingsPercentage: 0,
    localCompletionRate: 1,
    hasPricedUsage: true,
    hasUnpricedUsage: false,
    hasSavingsEstimate: false,
    ...overrides,
  };
}
