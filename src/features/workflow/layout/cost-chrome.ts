import type { CostPrediction } from '../../../core/schemas/summary.js';

export type PricingState = 'priced' | 'mixed' | 'local' | 'unpriced' | 'n/a';

export function formatCacheHitPct(cacheRead: number | undefined, input: number): string {
  if (cacheRead === undefined || cacheRead === 0) return 'cache n/a';
  const total = cacheRead + input;
  return `cache ${Math.round((cacheRead / total) * 100)}%`;
}

export function hasDisplayableCostPrediction(
  prediction: CostPrediction | undefined,
): prediction is CostPrediction {
  if (!prediction) return false;
  return (
    prediction.estimatedTasks > 0 ||
    prediction.expectedCost > 0 ||
    (prediction.deterministic?.taskCount ?? 0) > 0
  );
}

export function formatCostPredictionUnknownReasons(reasons: string[]): string {
  if (reasons.length === 0) return '';
  return `Unknown: ${reasons.join(', ')}`;
}
