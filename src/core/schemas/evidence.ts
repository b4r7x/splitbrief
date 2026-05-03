import { z } from 'zod';
import { TaskIdSchema } from './task.js';
import { ActionClassSchema, TaskStatusSchema, TaskCompletionMethodSchema, WorkflowModeSchema } from './enums.js';

export const EvidenceRejectionSchema = z.object({
  ts: z.string(),
  tier: z.enum(['sticky', 'confirm']),
  actionClass: ActionClassSchema,
  actionDescription: z.string(),
  taskId: TaskIdSchema.optional(),
  reason: z.string(),
});
export type EvidenceRejection = z.infer<typeof EvidenceRejectionSchema>;

export const EvidenceApprovalSchema = z.object({
  ts: z.string(),
  tier: z.literal('confirm'),
  actionClass: ActionClassSchema,
  actionDescription: z.string(),
  taskId: TaskIdSchema.optional(),
  reason: z.string(),
});
export type EvidenceApproval = z.infer<typeof EvidenceApprovalSchema>;

export const EvidenceValidationStageSchema = z.enum(['typecheck', 'lint', 'test']);
export type EvidenceValidationStage = z.infer<typeof EvidenceValidationStageSchema>;

export const EvidenceValidationEntrySchema = z.object({
  stage: EvidenceValidationStageSchema,
  passed: z.boolean(),
  errorSummary: z.string().optional(),
  retryState: z.enum(['initial-failure', 'retry', 'escalated', 'failed']).optional(),
  changedFiles: z.array(z.string()).optional(),
});
export type EvidenceValidationEntry = z.infer<typeof EvidenceValidationEntrySchema>;

export const EvidenceTaskSchema = z.object({
  id: TaskIdSchema,
  title: z.string(),
  file: z.string(),
  status: TaskStatusSchema,
  method: TaskCompletionMethodSchema.optional(),
  retries: z.number().nonnegative(),
  durationMs: z.number().nonnegative().optional(),
  changedFiles: z.array(z.string()),
  validation: z.array(EvidenceValidationEntrySchema),
  expectedEvidence: z.array(z.string()),
  observedEvidence: z.array(z.string()),
  escalated: z.boolean(),
  briefHash: z.string().nullable().optional(),
});
export type EvidenceTask = z.infer<typeof EvidenceTaskSchema>;

export const EvidenceFinalReviewStatusSchema = z.enum(['written', 'failed', 'skipped']);
export type EvidenceFinalReviewStatus = z.infer<typeof EvidenceFinalReviewStatusSchema>;

export const EvidenceFinalReviewSchema = z.object({
  path: z.string(),
  status: EvidenceFinalReviewStatusSchema,
});
export type EvidenceFinalReview = z.infer<typeof EvidenceFinalReviewSchema>;

export const EvidenceValidationSummarySchema = z.object({
  passed: z.number().nonnegative(),
  failed: z.number().nonnegative(),
  skipped: z.number().nonnegative(),
  escalated: z.number().nonnegative(),
});
export type EvidenceValidationSummary = z.infer<typeof EvidenceValidationSummarySchema>;

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
