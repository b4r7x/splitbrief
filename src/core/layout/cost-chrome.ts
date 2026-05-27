import type { CostPrediction } from '../schemas/summary.js';

export function formatCacheHitPct(cacheRead: number | undefined, input: number): string {
  if (cacheRead === undefined || cacheRead === 0 || input === 0) return 'cache n/a';
  const total = cacheRead + input;
  return `cache ${Math.round((cacheRead / total) * 100)}%`;
}

export function hasDisplayableCostPrediction(prediction: CostPrediction | undefined): prediction is CostPrediction {
  if (!prediction) return false;
  return prediction.estimatedTasks > 0 || prediction.expectedCost > 0 || (prediction.deterministic?.taskCount ?? 0) > 0;
}

export function formatCostPredictionUnknownReasons(reasons: string[]): string {
  if (reasons.length === 0) return '';
  return `Unknown: ${reasons.join(', ')}`;
}

export function plannerEstimateReviewLine(prediction: CostPrediction): string | null {
  const review = prediction.plannerEstimateReview;
  if (!review) return null;
  if (review.status === 'running') return 'Planner estimate review: extra planner call running';
  if (review.status === 'unavailable') return 'Planner estimate review: unavailable; deterministic estimate remains usable';
  return `Planner estimate review: extra planner call completed (${review.classification ?? 'unclassified'})`;
}
