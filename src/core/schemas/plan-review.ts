import type { ImplementerCostTier } from './implementer-config.js';
import type { UserEditConflictKind } from './enums.js';

export type PlanReviewRisk = 'low' | 'medium' | 'high';
export type PlanReviewContextFit = 'fits' | 'tight' | 'overflow';
export type PlanReviewEstimateStatus =
  | 'refreshed-current-code'
  | 'brief-current-code'
  | 'missing-current-code'
  | 'current-code-unavailable';

export interface PlanReviewConflictMetadata {
  kind: UserEditConflictKind;
  files: string[];
  affectedTaskIds?: string[] | undefined;
  note?: string | undefined;
}

export interface PlanTaskReviewMetadata {
  taskId: string;
  workerProfile?: string | undefined;
  selectedCostTier?: ImplementerCostTier | undefined;
  costPosture?: string | undefined;
  contextFit?: PlanReviewContextFit | undefined;
  estimatedTokens?: number | undefined;
  contextLength?: number | undefined;
  estimateStatus?: PlanReviewEstimateStatus | undefined;
  routingReason?: string | undefined;
  validationStatus?: 'pending' | 'pass' | 'warn' | 'fail' | undefined;
  risk?: PlanReviewRisk | undefined;
  stale?: boolean | undefined;
  conflict?: PlanReviewConflictMetadata | undefined;
  checkpoint?: string | undefined;
}
