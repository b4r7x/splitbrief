import type { CostPrediction } from '../../../src/core/schemas/summary.js';

export function makeCostPrediction(overrides: Partial<CostPrediction> = {}): CostPrediction {
  return {
    estimatedTasks: 12,
    lowCost: 0.08,
    expectedCost: 0.14,
    highCost: 0.35,
    plannerTool: 'anthropic',
    implementerTool: 'anthropic',
    deterministic: {
      estimateScope: 'prompt-input-only',
      taskCount: 12,
      taskFitCounts: { fits: 10, tight: 1, overflow: 0, unknown: 1 },
      contextConfidenceCounts: {
        contextExplicit: 5,
        contextDetected: 0,
        contextKnownCatalog: 4,
        contextCachedProvider: 2,
        contextConservativeFallback: 1,
        profileUnavailable: 0,
      },
      priceConfidenceCounts: { priceKnown: 12, priceUnknown: 0, profileUnavailable: 0 },
      tasks: [],
      totals: {
        knownActualEstimate: 0.14,
        hypotheticalAllPlanner: 1.2,
        estimatedSavings: 1.06,
        unknownCostReason: [],
      },
    },
    ...overrides,
  };
}
