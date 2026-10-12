import { z } from 'zod';
import {
  PhaseSchema,
  RecoveryActionSchema,
  RecoveryReasonSchema,
  RecoveryStatusSchema,
  RunnerKindSchema,
  TaskCompletionMethodSchema,
  TaskStatusSchema,
  WorkflowModeSchema,
} from './enums.js';
import { DriftFindingsSchema } from './drift.js';
import {
  readSavedRecoveryAction,
  readSavedRecoveryActions,
  readSavedRecoverySelections,
  SeatSwapCandidateSchema,
} from './recovery/schemas.js';
import { SeatSwitchRecordSchema } from './workflow.js';
import { EvidenceValidationStageSchema, EvidenceFinalReviewStatusSchema } from './evidence.js';
import {
  CostAmountBasisSchema,
  CostBreakdownSchema,
  ReviewFinalReviewStatusSchema,
  ReviewFindingCountsSchema,
  ReviewVerdictSchema,
} from './summary.js';
import { CheckStatusSchema, TaskIdSchema } from './task.js';
import { ReviewProvenanceSchema } from './review-changes.js';
import { TaskTokenUsageSchema, TokenUsageSchema } from './tokens.js';
import { RunSnapshotKindSchema } from './snapshot.js';
import {
  ReadinessNextActionKindSchema,
  ReadinessStatusSchema,
  StartReadinessCheckSchema,
} from './readiness.js';

export const REVIEW_PACKET_VERSION = 1;

export const REVIEW_INPUT_TRIMS = [
  'full-file-context',
  'undeclared-file-diffs',
  'task-evidence',
] as const;
export type ReviewInputTrim = (typeof REVIEW_INPUT_TRIMS)[number];

const ReviewPacketArtifactSourceSchema = z.object({
  path: z.string(),
  present: z.boolean(),
});

const ReviewPacketRunnerSchema = z.object({
  tool: z.string().nullable(),
  model: z.string().nullable(),
  /** The backend the seat ran on; a packet written before kinds were kept has none. */
  kind: RunnerKindSchema.nullable().optional(),
  axes: z.array(z.string()).optional(),
});

const ReviewPacketRunSchema = z.object({
  sessionId: z.string(),
  feature: z.string(),
  /** Always null since modes were retired; older packets name their mode. */
  mode: WorkflowModeSchema.nullable(),
  phase: PhaseSchema,
  planner: ReviewPacketRunnerSchema,
  implementer: ReviewPacketRunnerSchema,
  reviewer: ReviewPacketRunnerSchema.optional(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  totalTimeMs: z.number().nonnegative().nullable(),
  totalTasks: z.number().int().nonnegative(),
  escalated: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
});

const ReviewPacketReadinessSchema = z.object({
  path: z.string(),
  generatedAt: z.string().optional(),
  present: z.boolean(),
  status: ReadinessStatusSchema.nullable(),
  nextAction: ReadinessNextActionKindSchema.nullable(),
  blockerCount: z.number().int().nonnegative().nullable(),
  warningCount: z.number().int().nonnegative().nullable(),
  checks: z.array(StartReadinessCheckSchema),
});

const ReviewPacketTaskFileSchema = z.object({
  taskId: TaskIdSchema,
  title: z.string(),
  file: z.string(),
  files: z.array(z.string()).optional(),
  status: TaskStatusSchema,
  changedFiles: z.array(z.string()),
});

const ReviewPacketChangesSchema = z.object({
  changedFiles: z.array(z.string()),
  expectedFiles: z.array(z.string()),
  outOfScopeFiles: z.array(z.string()),
  taskFiles: z.array(ReviewPacketTaskFileSchema),
  diffReference: z.string(),
  provenance: ReviewProvenanceSchema.optional(),
});

const ReviewPacketCheckpointSafetySchema = z.object({
  hashGuarded: z.literal(true),
  conflictsSkippedByDefault: z.literal(true),
  forceOverwritesConflicts: z.literal(true),
  partialRestoreExpected: z.literal(true),
  excludedPaths: z.array(z.string()),
  text: z.object({
    hashGuarded: z.string(),
    conflictsSkippedByDefault: z.string(),
    forceOverwritesConflicts: z.string(),
    partialRestoreExpected: z.string(),
    excludedPaths: z.string(),
  }),
});

const ReviewPacketCheckpointSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  createdAt: z.string(),
  phase: z.enum(['planning', 'implementing', 'reviewing', 'manual']),
  taskIndex: z.number().int().nonnegative().optional(),
  trackedFileCount: z.number().int().nonnegative(),
  kind: z.enum(['manual', 'pre-task', 'post-task', 'pre-final-review', 'accepted-run', 'other']),
  inferredKind: z.enum(['pre-task', 'post-task', 'pre-final-review', 'accepted-run']).optional(),
  isRunCheckpoint: z.boolean(),
});

const ReviewPacketRunLedgerSchema = z.object({
  path: z.string(),
  present: z.boolean(),
  accepted: z.boolean().nullable(),
  rejected: z.boolean().nullable(),
  runSnapshotIds: z.array(z.string()),
  runSnapshotKinds: z.record(z.string(), RunSnapshotKindSchema),
  latestSnapshotId: z.string().nullable(),
});

const ReviewPacketCheckpointsSchema = z.object({
  items: z.array(ReviewPacketCheckpointSchema),
  latestRunCheckpoint: ReviewPacketCheckpointSchema.nullable(),
  preFinalReview: ReviewPacketCheckpointSchema.nullable(),
  runLedger: ReviewPacketRunLedgerSchema,
  safety: ReviewPacketCheckpointSafetySchema,
});

const ReviewPacketValidationTaskSchema = z.object({
  taskId: TaskIdSchema,
  title: z.string(),
  status: TaskStatusSchema,
  validation: z.array(
    z.object({
      stage: EvidenceValidationStageSchema,
      passed: z.boolean(),
      errorSummary: z.string().optional(),
      baselineExempt: z.boolean().optional(),
    }),
  ),
});

const ReviewPacketCheckEntrySchema = z.object({
  taskId: TaskIdSchema.optional(),
  id: z.string(),
  status: CheckStatusSchema.optional(),
  command: z.string().optional(),
  exitCode: z.number().int().optional(),
  output: z.string().optional(),
  preExisting: z.array(z.string()).optional(),
  artifacts: z.array(z.object({ path: z.string(), sha256: z.string() })).optional(),
  workspaceSnapshotId: z.string().optional(),
  ts: z.string().optional(),
});

const ReviewPacketChecksSchema = z.object({
  entries: z.array(ReviewPacketCheckEntrySchema).default([]),
  outsideReadPaths: z.array(z.string()).default([]),
});

const ReviewPacketValidationSchema = z.object({
  summary: z.object({
    passed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    escalated: z.number().int().nonnegative(),
  }),
  tasks: z.array(ReviewPacketValidationTaskSchema),
  finalReviewEvidenceStatus: EvidenceFinalReviewStatusSchema.nullable(),
});

const ReviewPacketApprovalEntrySchema = z.object({
  ts: z.string(),
  tier: z.string(),
  actionClass: z.string(),
  actionDescription: z.string(),
  taskId: TaskIdSchema.optional(),
  reason: z.string(),
});

const ReviewPacketEvidenceSchema = z.object({
  path: z.string().nullable(),
  present: z.boolean(),
  briefHash: z.string().nullable(),
  finalReview: z
    .object({
      path: z.string(),
      status: EvidenceFinalReviewStatusSchema,
    })
    .nullable(),
  approvals: z.array(ReviewPacketApprovalEntrySchema),
  rejections: z.array(ReviewPacketApprovalEntrySchema),
});

const ReviewPacketDriftSchema = z.object({
  path: z.string().nullable(),
  present: z.boolean(),
  passed: z.boolean().nullable(),
  errorCount: z.number().int().nonnegative(),
  warningCount: z.number().int().nonnegative(),
  changedFiles: z.array(z.string()),
  expectedFiles: z.array(z.string()),
  findings: DriftFindingsSchema,
  findingsBySeverity: z.object({
    info: DriftFindingsSchema,
    warning: DriftFindingsSchema,
    error: DriftFindingsSchema,
  }),
  briefHash: z.string().nullable(),
  briefQuality: z.object({
    path: z.string(),
    present: z.boolean(),
    passed: z.boolean().nullable(),
    score: z.number().min(0).max(1).nullable(),
    errorCount: z.number().int().nonnegative(),
    warningCount: z.number().int().nonnegative(),
  }),
});

export const ReviewPacketSeatSwitchSchema = SeatSwitchRecordSchema.omit({ ts: true }).extend({
  from: z.union([SeatSwapCandidateSchema, z.string()]),
  to: z.union([SeatSwapCandidateSchema, z.string()]),
});

const ReviewPacketEventSchema = z.preprocess(
  readSavedRecoveryActions,
  z.object({
    ...ReviewPacketSeatSwitchSchema.partial().shape,
    ts: z.string(),
    type: z.string(),
    phase: PhaseSchema.optional(),
    taskId: TaskIdSchema.optional(),
    issueId: z.string().optional(),
    reason: RecoveryReasonSchema.optional(),
    category: z.string().optional(),
    code: z.string().optional(),
    files: z.array(z.string()).optional(),
    affectedTaskIds: z.array(TaskIdSchema).optional(),
    availableActions: z.array(RecoveryActionSchema).optional(),
    recommendedAction: RecoveryActionSchema.optional(),
    action: RecoveryActionSchema.optional(),
    outcome: z.string().optional(),
    message: z.string().optional(),
  }),
);

const ReviewPacketRecoveryIssueSchema = z.preprocess(
  readSavedRecoveryActions,
  z.object({
    issueId: z.string(),
    reason: RecoveryReasonSchema,
    status: RecoveryStatusSchema,
    phase: PhaseSchema,
    taskId: TaskIdSchema.optional(),
    selectedAction: RecoveryActionSchema.optional(),
    recommendedAction: RecoveryActionSchema,
    availableActions: z.array(RecoveryActionSchema),
    files: z.array(z.string()),
    affectedTaskIds: z.array(TaskIdSchema),
  }),
);

const ReviewPacketRecoveryOutcomeSchema = z.object({
  issueId: z.string().nullable(),
  action: z.preprocess(readSavedRecoveryAction, RecoveryActionSchema.optional()),
  status: z.enum([
    'continued',
    'retry-current-task',
    'skipped',
    // Written by runs whose halts offered a pause; read only.
    'paused',
    'resumed',
    'aborted',
    'failed',
    'unresolved',
  ]),
  message: z.string().optional(),
});

const ReviewPacketRecoverySchema = z.object({
  sourceArtifacts: z.array(ReviewPacketArtifactSourceSchema),
  events: z.array(ReviewPacketEventSchema),
  currentIssue: ReviewPacketRecoveryIssueSchema.nullable(),
  selectedActions: z.preprocess(
    readSavedRecoverySelections,
    z.array(
      z.preprocess(
        readSavedRecoveryActions,
        z.object({
          issueId: z.string(),
          reason: RecoveryReasonSchema,
          action: RecoveryActionSchema,
          selectedAt: z.string(),
        }),
      ),
    ),
  ),
  outcomes: z.array(ReviewPacketRecoveryOutcomeSchema),
  unresolvedRisks: z.array(z.string()),
});

const ReviewPacketEscalationsSchema = z.object({
  retries: z.array(
    z.object({
      taskId: TaskIdSchema,
      retryCount: z.number().int().nonnegative(),
      lastError: z.string().nullable(),
    }),
  ),
  escalatedTasks: z.array(
    z.object({
      taskId: TaskIdSchema,
      title: z.string(),
      method: TaskCompletionMethodSchema.optional(),
    }),
  ),
  skippedTasks: z.array(
    z.object({
      taskId: TaskIdSchema,
      title: z.string(),
      reason: z.string().nullable(),
    }),
  ),
  failedTasks: z.array(
    z.object({
      taskId: TaskIdSchema,
      title: z.string(),
    }),
  ),
  warnings: z.array(ReviewPacketEventSchema),
});

const ReviewPacketCostSchema = z.object({
  tokenUsage: TokenUsageSchema,
  costBreakdown: CostBreakdownSchema.pick({
    actualPlannerCost: true,
    actualImplementerCost: true,
    actualReviewerCost: true,
    totalActualCost: true,
    hasPricedUsage: true,
    hasUnpricedUsage: true,
    isActualReviewerCostKnown: true,
    isTotalActualCostKnown: true,
    // The rates and identities the run was priced against travel with the
    // export, so a reader of the packet reads what it was priced at instead of
    // recosting it against whatever the catalog says by then.
    requestEstimate: true,
    providerRunMetadata: true,
  }).nullable(),
  /** What the amounts above are: a catalog estimate, unavailable, or a sum from
   * a run that recorded no provenance. Never an invoice. */
  amountBasis: CostAmountBasisSchema.default('legacy-unattributed'),
  taskRouting: z.array(TaskTokenUsageSchema),
  routingWarnings: z.array(ReviewPacketEventSchema),
});

const ReviewPacketFinalReviewSchema = z.object({
  path: z.string(),
  status: ReviewFinalReviewStatusSchema,
  evidenceStatus: EvidenceFinalReviewStatusSchema.nullable(),
  statusText: z.string(),
  excerpt: z.string().nullable(),
  verdict: ReviewVerdictSchema.nullable().default(null),
  criteriaPassed: z.number().int().nonnegative().default(0),
  criteriaFailed: z.number().int().nonnegative().default(0),
  findingCounts: ReviewFindingCountsSchema.default({ critical: 0, warning: 0, note: 0 }),
});

export const ReviewPacketSchema = z.object({
  version: z.literal(REVIEW_PACKET_VERSION),
  sessionId: z.string(),
  generatedAt: z.string(),
  run: ReviewPacketRunSchema,
  readiness: ReviewPacketReadinessSchema,
  changes: ReviewPacketChangesSchema,
  checkpoints: ReviewPacketCheckpointsSchema,
  recoveryDecisions: ReviewPacketRecoverySchema,
  validation: ReviewPacketValidationSchema,
  checks: ReviewPacketChecksSchema.default({ entries: [], outsideReadPaths: [] }),
  evidence: ReviewPacketEvidenceSchema,
  drift: ReviewPacketDriftSchema,
  escalations: ReviewPacketEscalationsSchema,
  cost: ReviewPacketCostSchema,
  finalReview: ReviewPacketFinalReviewSchema,
  reviewInput: z
    .object({
      chars: z.number().int().nonnegative(),
      maxChars: z.number().int().positive(),
      dropped: z.array(z.object({ trim: z.enum(REVIEW_INPUT_TRIMS), items: z.array(z.string()) })),
    })
    .optional(),
  reviewerChecklist: z.array(z.string()),
  missingArtifacts: z.array(z.string()),
});

export type ReviewPacket = z.infer<typeof ReviewPacketSchema>;
export type ReviewPacketCheckpoint = z.infer<typeof ReviewPacketCheckpointSchema>;
export type ReviewPacketFinalReviewStatus = z.infer<typeof ReviewPacketFinalReviewSchema>['status'];
