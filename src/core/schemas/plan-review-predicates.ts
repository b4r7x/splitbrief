import type { PlanReviewEstimateStatus, PlanTaskReviewMetadata } from './plan-review.js';

export const STALE_ESTIMATE_STATUSES = new Set<PlanReviewEstimateStatus | undefined>([
  'missing-current-code',
  'current-code-unavailable',
]);

export function hasNoCapableWorker(metadata: PlanTaskReviewMetadata): boolean {
  if (metadata.workerProfile !== undefined) return false;
  if (metadata.contextFit === 'overflow') return true;
  const reason = metadata.routingReason?.toLowerCase() ?? '';
  return reason.includes('no capable') || reason.includes('overflows');
}

export function hasStaleOrConflict(metadata: PlanTaskReviewMetadata | undefined): boolean {
  return (
    metadata?.stale === true ||
    metadata?.conflict !== undefined ||
    STALE_ESTIMATE_STATUSES.has(metadata?.estimateStatus)
  );
}

export function hasTruncatedContextReason(metadata: PlanTaskReviewMetadata | undefined): boolean {
  const reason = metadata?.routingReason?.toLowerCase() ?? '';
  return reason.includes('function-level context') || reason.includes('current code truncated');
}
