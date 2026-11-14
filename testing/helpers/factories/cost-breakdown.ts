import type { CostBreakdown } from '../../../src/core/schemas/cost.js';

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
