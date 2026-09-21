import type { PlanReviewEstimateStatus, PlanTaskReviewMetadata } from './types.js';

export const BLOCKING_ESTIMATE_STATUSES = new Set<PlanReviewEstimateStatus | undefined>([
  'current-code-unavailable',
]);

export function hasNoCapableWorker(metadata: PlanTaskReviewMetadata): boolean {
  if (metadata.workerProfile !== undefined) return false;
  if (metadata.contextFit === 'overflow') return true;
  return metadata.routingBlockKind === 'no-capable-worker';
}
