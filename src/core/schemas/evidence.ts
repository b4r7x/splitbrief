import { z } from 'zod';
import { CheckStatusSchema, TaskIdSchema } from './task.js';
import {
  ActionClassSchema,
  TaskStatusSchema,
  TaskCompletionMethodSchema,
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

const EvidenceCheckEntrySchema = z.object({
  id: z.string(),
  /** Absent on an older run's entry. */
  status: CheckStatusSchema.optional(),
  command: z.string().optional(),
  exitCode: z.number().int().optional(),
  output: z.string().optional(),
  preExisting: z.array(z.string()).optional(),
  base: z
    .object({ exitCode: z.number().int().optional(), output: z.string().optional() })
    .optional(),
  artifacts: z.array(z.object({ path: z.string(), sha256: z.string() })).optional(),
  workspaceSnapshotId: z.string().optional(),
  /** The time the run this entry reused ran: the same command on the same files ran once. */
  reusedAt: z.string().optional(),
  ts: z.string(),
});
export type EvidenceCheckEntry = z.infer<typeof EvidenceCheckEntrySchema>;

/**
 * The latest finished run of one command in one tree: the run's workspace or its run base. A later
 * check of the same command on the same tree state takes this result and runs nothing.
 */
const EvidenceCommandRunFields = z.object({
  tree: z.enum(['workspace', 'run-base']),
  /** The tree's state: the workspace's changed files and their contents, or the run base snapshot. */
  stateId: z.string(),
  command: z.string(),
  ts: z.string(),
  exitCode: z.number().int().optional(),
  output: z.string(),
});
const EvidenceCommandRunSchema = z.discriminatedUnion('status', [
  EvidenceCommandRunFields.extend({ status: z.literal('pass') }),
  EvidenceCommandRunFields.extend({
    status: z.literal('fail'),
    failure: z.object({
      keys: z.array(z.string()),
      placeholder: z.string().optional(),
      messages: z.record(z.string(), z.string()).optional(),
    }),
  }),
]);
export type EvidenceCommandRun = z.infer<typeof EvidenceCommandRunSchema>;

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

/** One review the run recorded: a task review or a final review, and what failed it. */
export const EvidenceReviewSchema = z.object({
  scope: z.enum(['task', 'final']),
  afterTaskId: TaskIdSchema.optional(),
  cycle: z.number().int().nonnegative(),
  outcome: z.enum(['pass', 'pass-with-notes', 'fail']),
  blocking: z.array(z.object({ id: z.string(), text: z.string() })),
  at: z.string(),
});
export type EvidenceReview = z.infer<typeof EvidenceReviewSchema>;

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
  /** Every review in the order it ran, so a failed review and its findings stay on record. */
  reviews: z.array(EvidenceReviewSchema).optional(),
  briefHash: z.string().nullable().optional(),
  approvals: z.array(EvidenceApprovalSchema).optional(),
  rejections: z.array(EvidenceRejectionSchema).optional(),
  commandRuns: z.array(EvidenceCommandRunSchema).optional(),
  /** The checks a review ran to verify its claims: no brief owns them. */
  verifyChecks: z.array(EvidenceCheckEntrySchema).optional(),
});
export type EvidenceLedger = z.infer<typeof EvidenceLedgerSchema>;
