import type { PlanReviewEstimateStatus, PlanTaskReviewMetadata } from './types.js';

export const STALE_ESTIMATE_STATUSES = new Set<PlanReviewEstimateStatus | undefined>([
  'missing-current-code',
  'current-code-unavailable',
]);

export function hasNoCapableWorker(metadata: PlanTaskReviewMetadata): boolean {
  if (metadata.workerProfile !== undefined) return false;
  if (metadata.contextFit === 'overflow') return true;
  return metadata.routingBlockKind === 'no-capable-worker';
}

export function hasStaleOrConflict(metadata: PlanTaskReviewMetadata | undefined): boolean {
  return (
    metadata?.stale === true ||
    metadata?.conflict !== undefined ||
    STALE_ESTIMATE_STATUSES.has(metadata?.estimateStatus)
  );
}
