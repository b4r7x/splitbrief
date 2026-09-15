import type { CostBreakdown } from '../../../src/core/schemas/summary.js';

export function makeCostBreakdown(overrides: Partial<CostBreakdown> = {}): CostBreakdown {
  return {
    actualPlannerCost: 0,
    actualImplementerCost: 0,
    totalActualCost: 0,
    hasPricedUsage: true,
    hasUnpricedUsage: false,
    ...overrides,
  };
}
