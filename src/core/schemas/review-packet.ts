import { z } from 'zod';
import {
  PhaseSchema,
  RecoveryActionSchema,
  RecoveryReasonSchema,
  TaskCompletionMethodSchema,
  TaskStatusSchema,
  WorkflowModeSchema,
} from './enums.js';
import { TaskIdSchema } from './task.js';
import { TaskTokenUsageSchema, TokenUsageSchema } from './tokens.js';
import { RunSnapshotKindSchema } from './snapshot.js';

export const REVIEW_PACKET_VERSION = 1;

const NullableStringSchema = z.string().nullable();

export const ReviewPacketArtifactSourceSchema = z.object({
  path: z.string(),
  present: z.boolean(),
});

export const ReviewPacketRunnerSchema = z.object({
  tool: z.string().nullable(),
  model: z.string().nullable(),
});

export const ReviewPacketRunSchema = z.object({
  sessionId: z.string(),
  feature: z.string(),
  mode: WorkflowModeSchema.nullable(),
  phase: PhaseSchema,
  planner: ReviewPacketRunnerSchema,
  implementer: ReviewPacketRunnerSchema,
  startedAt: NullableStringSchema,
  completedAt: NullableStringSchema,
  totalTimeMs: z.number().nonnegative().nullable(),
  totalTasks: z.number().int().nonnegative(),
  completedLocally: z.number().int().nonnegative(),
  escalated: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
});

export const ReviewPacketReadinessSchema = z.object({
  path: z.string(),
  present: z.boolean(),
  status: z.enum(['ready', 'ready-with-warnings', 'blocked']).nullable(),
  nextAction: z.enum([
    'continue',
    'run-init',
    'fix-config',
    'clean-or-isolate-repo',
    'raise-context',
    'set-budget',
    'exit',
  ]).nullable(),
  blockerCount: z.number().int().nonnegative().nullable(),
  warningCount: z.number().int().nonnegative().nullable(),
  checks: z.array(z.object({
    id: z.string(),
    severity: z.enum(['ok', 'info', 'warning', 'blocker']),
    summary: z.string(),
  })),
});

export const ReviewPacketTaskFileSchema = z.object({
  taskId: TaskIdSchema,
  title: z.string(),
  file: z.string(),
  status: TaskStatusSchema,
  changedFiles: z.array(z.string()),
  expectedEvidence: z.array(z.string()),
  observedEvidence: z.array(z.string()),
});

export const ReviewPacketChangesSchema = z.object({
  changedFiles: z.array(z.string()),
  expectedFiles: z.array(z.string()),
  outOfScopeFiles: z.array(z.string()),
  taskFiles: z.array(ReviewPacketTaskFileSchema),
  diffReference: z.string(),
});

export const ReviewPacketCheckpointSafetySchema = z.object({
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

export const ReviewPacketCheckpointSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  createdAt: z.string(),
  phase: z.enum(['planning', 'implementing', 'reviewing', 'manual']),
  taskIndex: z.number().int().nonnegative().optional(),
  trackedFileCount: z.number().int().nonnegative(),
  kind: z.enum(['manual', 'pre-task', 'post-task', 'pre-final-review', 'accepted-run', 'other']),
  inferredKind: z.enum(['pre-task', 'post-task', 'pre-final-review', 'accepted-run']).optional(),
  isRunCheckpoint: z.boolean(),
  diffCommand: z.string(),
  restoreCommand: z.string(),
  safety: ReviewPacketCheckpointSafetySchema,
});

export const ReviewPacketRunLedgerSchema = z.object({
  path: z.string(),
  present: z.boolean(),
  accepted: z.boolean().nullable(),
  rejected: z.boolean().nullable(),
  runSnapshotIds: z.array(z.string()),
  runSnapshotKinds: z.record(z.string(), RunSnapshotKindSchema),
  latestSnapshotId: z.string().nullable(),
});

export const ReviewPacketCheckpointsSchema = z.object({
  items: z.array(ReviewPacketCheckpointSchema),
  latestRunCheckpoint: ReviewPacketCheckpointSchema.nullable(),
  preFinalReview: ReviewPacketCheckpointSchema.nullable(),
  runLedger: ReviewPacketRunLedgerSchema,
});

export const ReviewPacketValidationTaskSchema = z.object({
  taskId: TaskIdSchema,
  title: z.string(),
  status: TaskStatusSchema,
  validation: z.array(z.object({
    stage: z.enum(['typecheck', 'lint', 'test']),
    passed: z.boolean(),
    errorSummary: z.string().optional(),
  })),
  expectedEvidence: z.array(z.string()),
  observedEvidence: z.array(z.string()),
  missingExpectedEvidence: z.array(z.string()),
});

export const ReviewPacketValidationSchema = z.object({
  summary: z.object({
    passed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    escalated: z.number().int().nonnegative(),
  }),
  tasks: z.array(ReviewPacketValidationTaskSchema),
  finalReviewEvidenceStatus: z.enum(['written', 'failed', 'skipped']).nullable(),
  missingEvidenceWarnings: z.array(z.string()),
});

export const ReviewPacketEvidenceSchema = z.object({
  path: z.string().nullable(),
  present: z.boolean(),
  briefHash: z.string().nullable(),
  finalReview: z.object({
    path: z.string(),
    status: z.enum(['written', 'failed', 'skipped']),
  }).nullable(),
  approvals: z.array(z.object({
    ts: z.string(),
    tier: z.string(),
    actionClass: z.string(),
    actionDescription: z.string(),
    taskId: TaskIdSchema.optional(),
    reason: z.string(),
  })),
  rejections: z.array(z.object({
    ts: z.string(),
    tier: z.string(),
    actionClass: z.string(),
    actionDescription: z.string(),
    taskId: TaskIdSchema.optional(),
    reason: z.string(),
  })),
});

export const ReviewPacketDriftFindingSchema = z.object({
  severity: z.enum(['info', 'warning', 'error']),
  code: z.string(),
  taskId: z.string().optional(),
  file: z.string().optional(),
  message: z.string(),
});

export const ReviewPacketDriftSchema = z.object({
  path: z.string().nullable(),
  present: z.boolean(),
  passed: z.boolean().nullable(),
  score: z.number().min(0).max(1).nullable(),
  errorCount: z.number().int().nonnegative(),
  warningCount: z.number().int().nonnegative(),
  changedFiles: z.array(z.string()),
  expectedFiles: z.array(z.string()),
  findings: z.array(ReviewPacketDriftFindingSchema),
  findingsBySeverity: z.object({
    info: z.array(ReviewPacketDriftFindingSchema),
    warning: z.array(ReviewPacketDriftFindingSchema),
    error: z.array(ReviewPacketDriftFindingSchema),
  }),
  briefHash: z.string().nullable(),
  chainSummary: z.object({
    path: z.string(),
    present: z.boolean(),
    emittedChainCount: z.number().int().nonnegative(),
    topChain: z.object({
      chainLength: z.number().int().positive(),
      score: z.number().min(0).max(1),
      uniqueOutOfBoundsFiles: z.array(z.string()),
      representativePath: z.string(),
      detectedAtTaskId: z.string(),
    }).nullable(),
  }),
  briefQuality: z.object({
    path: z.string(),
    present: z.boolean(),
    passed: z.boolean().nullable(),
    score: z.number().min(0).max(1).nullable(),
    errorCount: z.number().int().nonnegative(),
    warningCount: z.number().int().nonnegative(),
  }),
});

export const ReviewPacketEventSchema = z.object({
  ts: z.string(),
  type: z.string(),
  phase: PhaseSchema.optional(),
  taskId: TaskIdSchema.optional(),
  issueId: z.string().optional(),
  reason: RecoveryReasonSchema.optional(),
  files: z.array(z.string()).optional(),
  affectedTaskIds: z.array(TaskIdSchema).optional(),
  availableActions: z.array(RecoveryActionSchema).optional(),
  recommendedAction: RecoveryActionSchema.optional(),
  action: RecoveryActionSchema.optional(),
  outcome: z.string().optional(),
  message: z.string().optional(),
});

export const ReviewPacketRecoveryIssueSchema = z.object({
  issueId: z.string(),
  reason: RecoveryReasonSchema,
  status: z.enum(['awaiting-user', 'paused', 'applying']),
  phase: PhaseSchema,
  taskId: TaskIdSchema.optional(),
  selectedAction: RecoveryActionSchema.optional(),
  recommendedAction: RecoveryActionSchema,
  availableActions: z.array(RecoveryActionSchema),
  files: z.array(z.string()),
  affectedTaskIds: z.array(TaskIdSchema),
});

export const ReviewPacketRecoveryOutcomeSchema = z.object({
  issueId: z.string().nullable(),
  action: RecoveryActionSchema.optional(),
  status: z.enum(['continued', 'retry-current-task', 'skipped', 'paused', 'resumed', 'aborted', 'failed', 'unresolved']),
  message: z.string().optional(),
});

export const ReviewPacketRecoverySchema = z.object({
  sourceArtifacts: z.array(ReviewPacketArtifactSourceSchema),
  events: z.array(ReviewPacketEventSchema),
  currentIssue: ReviewPacketRecoveryIssueSchema.nullable(),
  selectedActions: z.array(z.object({
    issueId: z.string(),
    reason: RecoveryReasonSchema,
    action: RecoveryActionSchema,
    selectedAt: z.string(),
  })),
  outcomes: z.array(ReviewPacketRecoveryOutcomeSchema),
  unresolvedRisks: z.array(z.string()),
});

export const ReviewPacketEscalationsSchema = z.object({
  retries: z.array(z.object({
    taskId: TaskIdSchema,
    retryCount: z.number().int().nonnegative(),
    lastError: z.string().nullable(),
  })),
  escalatedTasks: z.array(z.object({
    taskId: TaskIdSchema,
    title: z.string(),
    method: TaskCompletionMethodSchema.optional(),
  })),
  skippedTasks: z.array(z.object({
    taskId: TaskIdSchema,
    title: z.string(),
    reason: z.string().nullable(),
  })),
  failedTasks: z.array(z.object({
    taskId: TaskIdSchema,
    title: z.string(),
  })),
  warnings: z.array(ReviewPacketEventSchema),
});

export const ReviewPacketCostSchema = z.object({
  tokenUsage: TokenUsageSchema,
  costBreakdown: z.object({
    hypotheticalCost: z.number().nonnegative(),
    actualPlannerCost: z.number().nonnegative(),
    actualImplementerCost: z.number().nonnegative(),
    totalActualCost: z.number().nonnegative(),
    savingsAmount: z.number(),
    savingsPercentage: z.number(),
    localCompletionRate: z.number().nonnegative().max(1),
    hasPricedUsage: z.boolean().optional(),
    hasUnpricedUsage: z.boolean().optional(),
    hasSavingsEstimate: z.boolean().optional(),
    isTotalActualCostKnown: z.boolean().optional(),
    isAllPlannerBaselineKnown: z.boolean().optional(),
  }).nullable(),
  estimatedCostSavings: z.string().nullable(),
  taskRouting: z.array(TaskTokenUsageSchema),
  routingWarnings: z.array(ReviewPacketEventSchema),
});

export const ReviewPacketFinalReviewSchema = z.object({
  path: z.string(),
  status: z.enum(['written', 'failed', 'missing', 'skipped']),
  evidenceStatus: z.enum(['written', 'failed', 'skipped']).nullable(),
  statusText: z.string(),
  excerpt: z.string().nullable(),
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
  evidence: ReviewPacketEvidenceSchema,
  drift: ReviewPacketDriftSchema,
  escalations: ReviewPacketEscalationsSchema,
  cost: ReviewPacketCostSchema,
  finalReview: ReviewPacketFinalReviewSchema,
  reviewerChecklist: z.array(z.string()),
  missingArtifacts: z.array(z.string()),
});

export type ReviewPacket = z.infer<typeof ReviewPacketSchema>;
export type ReviewPacketCheckpoint = z.infer<typeof ReviewPacketCheckpointSchema>;
export type ReviewPacketFinalReviewStatus = z.infer<typeof ReviewPacketFinalReviewSchema>['status'];
