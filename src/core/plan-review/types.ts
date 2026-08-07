import type { ImplementerCostTier } from '../schemas/implementer-config.js';
import type {
  CurrentCodeContextMode,
  TaskContextFit,
  UserEditConflictKind,
} from '../schemas/enums.js';
import type { TaskId } from '../schemas/task.js';

export type PlanReviewRisk = 'low' | 'medium' | 'high';
export type PlanReviewEstimateStatus =
  | 'refreshed-current-code'
  | 'brief-current-code'
  | 'missing-current-code'
  | 'current-code-unavailable'
  | 'pending-earlier-task';

export type PlanReviewRoutingBlockKind = 'no-capable-worker';

export interface PlanReviewConflictMetadata {
  kind: UserEditConflictKind;
  files: string[];
  affectedTaskIds?: string[] | undefined;
  note?: string | undefined;
}

export interface PlanTaskReviewMetadata {
  taskId: TaskId;
  workerProfile?: string | undefined;
  selectedCostTier?: ImplementerCostTier | undefined;
  costPosture?: string | undefined;
  contextFit?: TaskContextFit | undefined;
  estimatedTokens?: number | undefined;
  contextLength?: number | undefined;
  estimateStatus?: PlanReviewEstimateStatus | undefined;
  routingReason?: string | undefined;
  routingBlockKind?: PlanReviewRoutingBlockKind | undefined;
  currentCodeContextMode?: CurrentCodeContextMode | undefined;
  currentCodeTruncated?: boolean | undefined;
  validationStatus?: 'pending' | 'pass' | 'warn' | 'fail' | undefined;
  risk?: PlanReviewRisk | undefined;
  stale?: boolean | undefined;
  conflict?: PlanReviewConflictMetadata | undefined;
  checkpoint?: string | undefined;
}
