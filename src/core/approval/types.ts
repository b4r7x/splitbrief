import type { ApprovalTier } from '../schemas/config.js';
import type { ActionClass } from '../schemas/enums.js';
import type { Phase } from '../schemas/enums.js';
import type { TaskId } from '../schemas/task.js';

export type {
  BriefAdmissionInput,
  BriefContinuationV1,
  BriefContractStatus,
  BriefQualityIssue,
  BriefQualityReportEvidence,
  BriefRecoveryAction,
  BriefRecoveryCommand,
  BriefRecoveryController,
  BriefRecoveryControllerDeps,
  BriefRecoveryInspection,
  BriefRecoveryMigrationInput,
  BriefRecoveryOrigin,
  BriefRecoveryProjectionV1,
  BriefRecoveryProviderPort,
  BriefRecoveryBudgetPort,
  DispatchPossibility,
  EvidenceRef,
  InputLifecycleEvent,
  InputReceipt,
  InputState,
  MigrationResultV1,
  PlannerAttemptSettlement,
  QueueBriefInput,
  QueueResultV1,
  RecoveryBlocker,
  RecoveryReceipt,
  RecoveryResult,
  RecoveryResultV1,
  RecoveryUsage,
  StateAuthorityReceipt,
} from '../schemas/brief-recovery.js';

export const CONFIRM_PHRASE = 'I confirm';

export type TieredApprovalRequest = {
  tier: ApprovalTier;
  actionClass: ActionClass;
  actionDescription: string;
  taskId?: TaskId | undefined;
  phase: Phase;
};

export type TieredApprovalResponse =
  | { decision: 'allow'; scope: 'once' | 'session' | 'always' }
  | { decision: 'deny'; reason: string }
  | { decision: 'confirm'; phrase: string; reason: string };

export type ApprovalReviewResult =
  | { approved: true; action?: undefined; comment?: undefined }
  | { approved: false; action: 'edit'; comment?: string | undefined }
  | { approved: false; action: 'revise'; comment: string; taskIds?: TaskId[] | undefined }
  | { approved: false; action?: undefined; comment?: undefined };
