import { z } from 'zod';
import { TaskIdSchema } from './task.js';
import {
  ActionClassSchema,
  TaskStatusSchema,
  TaskCompletionMethodSchema,
  ValidationStageSchema,
  WorkflowModeSchema,
} from './enums.js';

const EvidenceRejectionSchema = z.object({
  ts: z.string(),
  tier: z.enum(['sticky', 'confirm']),
  actionClass: ActionClassSchema,
  actionDescription: z.string(),
  taskId: TaskIdSchema.optional(),
  reason: z.string(),
});
export type EvidenceRejection = z.infer<typeof EvidenceRejectionSchema>;

const EvidenceApprovalSchema = z.object({
  ts: z.string(),
  tier: z.literal('confirm'),
  actionClass: ActionClassSchema,
  actionDescription: z.string(),
  taskId: TaskIdSchema.optional(),
  reason: z.string(),
});
export type EvidenceApproval = z.infer<typeof EvidenceApprovalSchema>;

export const EvidenceValidationStageSchema = ValidationStageSchema;

const EvidenceValidationEntrySchema = z.object({
  stage: EvidenceValidationStageSchema,
  passed: z.boolean(),
  /** The exact command the orchestrator ran for this stage. */
  command: z.string().optional(),
  /** Recorded command output (already redacted and truncated at capture). */
  output: z.string().optional(),
  errorSummary: z.string().optional(),
  retryState: z.enum(['initial-failure', 'retry', 'escalated', 'failed']).optional(),
  changedFiles: z.array(z.string()).optional(),
  baselineExempt: z.boolean().optional(),
  skipped: z.boolean().optional(),
  skippedReason: z.string().optional(),
});
export type EvidenceValidationEntry = z.infer<typeof EvidenceValidationEntrySchema>;

const EvidenceCheckEntrySchema = z.object({
  id: z.string(),
  command: z.string().optional(),
  exitCode: z.number().int().optional(),
  output: z.string().optional(),
  artifacts: z.array(z.object({ path: z.string(), sha256: z.string() })).optional(),
  workspaceSnapshotId: z.string().optional(),
  ts: z.string(),
});
export type EvidenceCheckEntry = z.infer<typeof EvidenceCheckEntrySchema>;

const EvidencePromotedFileSchema = z.object({
  path: z.string(),
  /** Digest supplied by the writer; null only for a recorded deletion. */
  sha256: z.string().nullable(),
  mode: z.number().nonnegative().nullable(),
  /** This write created a target that the acquisition baseline proved absent. */
  created: z.literal(true).optional(),
});
export type EvidencePromotedFile = z.infer<typeof EvidencePromotedFileSchema>;

const EvidencePromotionAttemptSchema = z.object({
  ts: z.string(),
  /** The exact prefix promotion applied to the target before it stopped. */
  appliedFiles: z.array(EvidencePromotedFileSchema),
  failedFile: z.string(),
  error: z.string(),
});
export type EvidencePromotionAttempt = z.infer<typeof EvidencePromotionAttemptSchema>;

const EvidenceApiAppliedFileSchema = z.object({
  path: z.string(),
  action: z.enum(['create', 'modify']),
  /** Digest the target held before the write; null when it did not exist. */
  beforeSha256: z.string().nullable(),
  afterSha256: z.string(),
  afterMode: z.number().nonnegative().optional(),
});

/**
 * What one `file-bundle-v1` response did to the confined filesystem. Digests and
 * paths only: the ledger records which content a target held, never the content
 * itself. A task entry without this receipt says nothing was recorded, which is
 * unknown rather than a claim that nothing was applied.
 */
const EvidenceApiApplySchema = z.object({
  /** The call whose response this applied; null when refused before any call. */
  callId: z.string().nullable(),
  grammar: z.literal('file-bundle-v1'),
  /** Present for worker-only effects, which have not been attributed to the target. */
  workspacePath: z.string().optional(),
  status: z.enum(['applied', 'rejected', 'partial', 'failed']),
  candidatePaths: z.array(z.string()),
  applied: z.array(EvidenceApiAppliedFileSchema),
  noops: z.array(z.string()),
  untouched: z.array(z.string()),
  failedPath: z.string().optional(),
  code: z.string().optional(),
  /** Applied files a checkout recovery put back; they prove no creation. */
  revertedPaths: z.array(z.string()).optional(),
});
export type EvidenceApiApply = z.infer<typeof EvidenceApiApplySchema>;

const EvidenceTaskSchema = z.object({
  id: TaskIdSchema,
  title: z.string(),
  file: z.string(),
  status: TaskStatusSchema,
  method: TaskCompletionMethodSchema.optional(),
  retries: z.number().nonnegative(),
  durationMs: z.number().nonnegative().optional(),
  changedFiles: z.array(z.string()),
  validation: z.array(EvidenceValidationEntrySchema),
  checks: z.array(EvidenceCheckEntrySchema).optional(),
  expectedEvidence: z.array(z.string()).optional(),
  observedEvidence: z.array(z.string()).optional(),
  escalated: z.boolean(),
  briefHash: z.string().nullable().optional(),
  promotionAttempts: z.array(EvidencePromotionAttemptSchema).optional(),
  /** Latest writer receipts for this brief, with one current owner per target path. */
  promotedFiles: z.array(EvidencePromotedFileSchema).optional(),
  /** Hash of this single brief, excluding runtime status and current-code context. */
  promotedBriefHash: z.string().optional(),
  apiApply: EvidenceApiApplySchema.optional(),
  /** Proven target creations accumulated across this task's writer receipts. */
  apiCreatedPaths: z.array(z.string().min(1)).optional(),
});
export type EvidenceTask = z.infer<typeof EvidenceTaskSchema>;

export const EvidenceFinalReviewStatusSchema = z.enum(['written', 'failed', 'skipped']);
export type EvidenceFinalReviewStatus = z.infer<typeof EvidenceFinalReviewStatusSchema>;

const EvidenceFinalReviewSchema = z.object({
  path: z.string(),
  status: EvidenceFinalReviewStatusSchema,
});

const EvidenceValidationSummarySchema = z.object({
  passed: z.number().nonnegative(),
  failed: z.number().nonnegative(),
  skipped: z.number().nonnegative(),
  escalated: z.number().nonnegative(),
});

export const EvidenceLedgerSchema = z.object({
  version: z.literal(1),
  sessionId: z.string(),
  feature: z.string(),
  mode: WorkflowModeSchema.optional(),
  generatedAt: z.string(),
  tasks: z.array(EvidenceTaskSchema),
  validationSummary: EvidenceValidationSummarySchema,
  finalReview: EvidenceFinalReviewSchema.optional(),
  briefHash: z.string().nullable().optional(),
  approvals: z.array(EvidenceApprovalSchema).optional(),
  rejections: z.array(EvidenceRejectionSchema).optional(),
});
export type EvidenceLedger = z.infer<typeof EvidenceLedgerSchema>;
