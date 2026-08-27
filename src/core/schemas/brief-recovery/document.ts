import { z } from 'zod';
import {
  AttemptSummarySchema,
  BriefReadinessDecisionSchema,
  BriefRecoveryQueuedInputsSchema,
  InputReceiptSchema,
  RecoveryReceiptSchema,
  automaticRepairSchema,
  matchingReportSchema,
  outboxEntrySchema,
} from './attempt.js';
import {
  BriefContinuationV1Schema,
  BriefContractStatusSchema,
  BriefQualityIssueSchema,
  BriefRecoveryActionSchema,
  BriefRecoveryOriginSchema,
  EvidenceRefSchema,
  MAX_ID,
  MAX_INPUTS,
  MAX_ISSUES,
  MAX_OUTBOX,
  finiteAmount,
  hash,
  id,
  message,
  nonNegativeInteger,
  timestamp,
} from './primitives.js';
import { RecoveryRefusalRetentionSchema } from './refusal.js';

const normalRecoveryBaseShape = {
  version: z.literal(1),
  recoveryRevision: nonNegativeInteger,
  epochId: id,
  origin: BriefRecoveryOriginSchema,
  continuation: BriefContinuationV1Schema,
  status: BriefContractStatusSchema.exclude(['storage-blocked']),
  activeBrief: EvidenceRefSchema,
  matchingReport: matchingReportSchema.nullable(),
  readinessDecision: BriefReadinessDecisionSchema.optional(),
  qualityPolicyVersion: id,
  automaticRepair: automaticRepairSchema,
  committedSpend: finiteAmount.optional(),
  attempts: z.record(id, RecoveryReceiptSchema),
  activeOperationId: id.nullable(),
  inputs: z.array(InputReceiptSchema).max(MAX_INPUTS).readonly(),
  nextInputSequence: z.number().int().positive(),
  noProgress: z.object({ fingerprint: hash.nullable(), count: nonNegativeInteger }).strict(),
  evidenceHead: id,
  outbox: z.array(outboxEntrySchema).max(MAX_OUTBOX).readonly(),
  refusalRetention: RecoveryRefusalRetentionSchema.optional(),
} as const;

export const NormalBriefRecoveryV1Schema = z
  .object(normalRecoveryBaseShape)
  .superRefine((value, ctx) => {
    if (
      value.matchingReport !== null &&
      value.matchingReport.briefHash !== value.activeBrief.hash
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['matchingReport', 'briefHash'],
        message: 'matchingReport must identify the active Brief',
      });
    }
    for (const [mapKey, receipt] of Object.entries(value.attempts)) {
      if (mapKey !== receipt.operationId) {
        ctx.addIssue({
          code: 'custom',
          path: ['attempts', mapKey],
          message: 'attempt map keys must equal embedded operation IDs',
        });
      }
      if (receipt.epochId !== value.epochId) {
        ctx.addIssue({
          code: 'custom',
          path: ['attempts', mapKey, 'epochId'],
          message: 'attempt epoch must match recovery epoch',
        });
      }
      const key = receipt.reservation.accountingKey;
      if (key.epochId !== receipt.epochId || key.operationId !== receipt.operationId) {
        ctx.addIssue({
          code: 'custom',
          path: ['attempts', mapKey, 'reservation', 'accountingKey'],
          message: 'budget accounting key must match its receipt',
        });
      }
    }
    if (value.activeOperationId !== null) {
      const active = value.attempts[value.activeOperationId];
      if (active === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['activeOperationId'],
          message: 'activeOperationId must reference an attempt',
        });
      } else if (
        active.status !== 'accepted' &&
        active.status !== 'started' &&
        active.status !== 'unresolved'
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['activeOperationId'],
          message: 'activeOperationId must reference an in-flight attempt',
        });
      }
    }
    if (
      (value.status === 'retrying' || value.status === 'auto-repairing') &&
      value.activeOperationId === null
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['activeOperationId'],
        message: 'retrying and auto-repairing states require an active operation',
      });
    }
    if (value.status === 'ready' && value.matchingReport !== null) {
      const errors = value.matchingReport.issues.some((issue) => issue.severity === 'error');
      if (errors) {
        ctx.addIssue({
          code: 'custom',
          path: ['status'],
          message: 'a report with errors cannot be Contract Ready',
        });
      }
    }
    const inputIds = new Set<string>();
    for (const input of value.inputs) {
      if (inputIds.has(input.inputId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['inputs'],
          message: 'input IDs must be unique within an epoch',
        });
      }
      inputIds.add(input.inputId);
    }
  })
  .strict();
export type NormalBriefRecoveryV1 = z.infer<typeof NormalBriefRecoveryV1Schema>;

export const StorageBlockedBriefRecoveryV1Schema = z
  .object({
    version: z.literal(1),
    recoveryRevision: nonNegativeInteger,
    epochId: id,
    origin: BriefRecoveryOriginSchema,
    continuation: BriefContinuationV1Schema,
    status: z.literal('storage-blocked'),
    activeBrief: z.null(),
    storageEvidence: z.object({ code: id, artifactRef: id.nullable() }).strict(),
    evidenceHead: id,
    outbox: z.array(outboxEntrySchema).max(MAX_OUTBOX).readonly(),
  })
  .strict();
export type StorageBlockedBriefRecoveryV1 = z.infer<typeof StorageBlockedBriefRecoveryV1Schema>;

export const RejectedStorageBriefRecoveryV1Schema = z
  .object({
    version: z.literal(1),
    recoveryRevision: nonNegativeInteger,
    epochId: id,
    origin: BriefRecoveryOriginSchema,
    continuation: BriefContinuationV1Schema,
    status: z.literal('rejected'),
    activeBrief: z.null(),
    storageEvidence: z.object({ code: id, artifactRef: id.nullable() }).strict(),
    evidenceHead: id,
    outbox: z.array(outboxEntrySchema).max(MAX_OUTBOX).readonly(),
  })
  .strict();
export type RejectedStorageBriefRecoveryV1 = z.infer<typeof RejectedStorageBriefRecoveryV1Schema>;

export const BriefRecoveryV1Schema = z.union([
  NormalBriefRecoveryV1Schema,
  StorageBlockedBriefRecoveryV1Schema,
  RejectedStorageBriefRecoveryV1Schema,
]);
export type BriefRecoveryV1 = z.infer<typeof BriefRecoveryV1Schema>;

export const RecoveryBlockerSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('quality'),
      issues: z.array(BriefQualityIssueSchema).max(MAX_ISSUES).readonly(),
    })
    .strict(),
  z.object({ kind: z.literal('provider'), code: id, message }).strict(),
  z
    .object({
      kind: z.literal('budget'),
      code: z.enum(['brief_budget_exhausted', 'brief_budget_unknown']),
      remaining: finiteAmount.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('no-progress'),
      code: z.literal('brief_no_progress'),
      fingerprint: hash,
      count: nonNegativeInteger,
    })
    .strict(),
  z
    .object({
      kind: z.literal('storage'),
      code: z.enum(['brief_storage_invalid', 'brief_version_invalid']),
      message,
    })
    .strict(),
  z
    .object({ kind: z.literal('unresolved'), code: z.literal('brief_unresolved'), operationId: id })
    .strict(),
]);
export type RecoveryBlocker = z.infer<typeof RecoveryBlockerSchema>;

export const BriefRecoveryProjectionV1Schema = z
  .object({
    version: z.literal(1),
    sessionId: id,
    stateRevision: nonNegativeInteger,
    recoveryRevision: nonNegativeInteger,
    epochId: id.nullable(),
    status: BriefContractStatusSchema,
    origin: BriefRecoveryOriginSchema.nullable(),
    continuation: BriefContinuationV1Schema.nullable(),
    activeBrief: EvidenceRefSchema.nullable(),
    matchingReport: matchingReportSchema.nullable(),
    blocker: RecoveryBlockerSchema.nullable(),
    allowedActions: z.array(BriefRecoveryActionSchema).max(16).readonly(),
    activeOperation: AttemptSummarySchema.nullable(),
    latestAttempt: AttemptSummarySchema.nullable(),
    queuedInputs: BriefRecoveryQueuedInputsSchema,
    budget: z
      .object({
        state: z.enum(['available', 'reserved', 'held', 'refused']),
        refusalCode: id.nullable(),
        remoteUsage: z.literal('REMOTE USAGE UNKNOWN').nullable(),
      })
      .strict()
      .optional(),
    remoteUsage: z.literal('REMOTE USAGE UNKNOWN').optional(),
  })
  .superRefine((value, ctx) => {
    if (value.activeBrief !== null && value.matchingReport !== null) {
      if (value.activeBrief.hash !== value.matchingReport.briefHash) {
        ctx.addIssue({
          code: 'custom',
          path: ['matchingReport', 'briefHash'],
          message: 'projection report must identify the active Brief',
        });
      }
    }
    if (value.status === 'storage-blocked' && value.activeBrief !== null) {
      ctx.addIssue({
        code: 'custom',
        path: ['activeBrief'],
        message: 'storage-blocked projections cannot expose an active Brief',
      });
    }
    if (value.status === 'ready' && value.matchingReport !== null) {
      if (value.matchingReport.issues.some((issue) => issue.severity === 'error')) {
        ctx.addIssue({
          code: 'custom',
          path: ['status'],
          message: 'a projection with quality errors cannot be ready',
        });
      }
    }
  })
  .strict();
export type BriefRecoveryProjectionV1 = z.infer<typeof BriefRecoveryProjectionV1Schema>;

export type BriefRecoveryStateView = {
  stateVersion: number;
  stateRevision: number;
  stateFence: { token: number; ownerId: string };
  phase: string;
  briefRecovery: BriefRecoveryV1 | null;
};

export const BriefRecoveryStateViewSchema = z
  .object({
    stateVersion: nonNegativeInteger,
    stateRevision: nonNegativeInteger,
    stateFence: z.object({ token: nonNegativeInteger, ownerId: id }).strict(),
    phase: z.string().min(1).max(MAX_ID),
    briefRecovery: BriefRecoveryV1Schema.nullable(),
  })
  .strict();

export const BriefRecoveryInspectionSchema = z
  .object({
    sessionId: id,
    state: BriefRecoveryStateViewSchema,
    stateDigest: hash.optional(),
    now: timestamp,
  })
  .strict();
export type BriefRecoveryInspection = z.infer<typeof BriefRecoveryInspectionSchema>;
