import { z } from 'zod';
import {
  BriefRecoveryActionSchema,
  EvidenceRefSchema,
  finiteAmount,
  hash,
  id,
  message,
  nonNegativeInteger,
  timestamp,
} from './primitives.js';

export const RECOVERY_REFUSAL_RETENTION = {
  version: 1,
  maxCurrentEpochRecords: 64,
  maxReceiptBytes: 1_024,
  maxCurrentEpochBytes: 64 * 1_024,
  maxDiagnosticBytes: 4_096,
  maxCurrentEpochEvidenceBytes: 256 * 1_024,
  maxClosedEpochSummaries: 16,
  maxClosedEpochSummaryBytes: 512,
  maxClosedEpochBytes: 8 * 1_024,
} as const;

export const RECOVERY_REFUSAL_CODES = [
  'brief_budget_unknown',
  'brief_budget_exhausted',
  'brief_compiler_capacity',
  'brief_compiler_unbounded',
  'brief_capability_unsupported',
  'brief_no_progress',
  'brief_intent_conflict',
  'brief_storage_invalid',
  'brief_provider_error',
] as const;
export const RecoveryRefusalCodeSchema = z.enum(RECOVERY_REFUSAL_CODES);
export type RecoveryRefusalCode = z.infer<typeof RecoveryRefusalCodeSchema>;

export const RecoveryRefusalReceiptSchema = z
  .object({
    epochId: id,
    operationId: id,
    intentHash: hash,
    action: BriefRecoveryActionSchema,
    code: RecoveryRefusalCodeSchema,
    category: z.enum(['budget', 'compiler', 'capability', 'storage', 'provider', 'policy']),
    reasonCode: id,
    reason: message.optional(),
    at: timestamp,
    accountingKey: id.nullable(),
    budgetPolicy: z.enum(['no-dollar-cap', 'usd-cap']),
    configuredCap: finiteAmount.nullable(),
    priceKnownness: z.enum(['finite-usd', 'provider-dependent', 'inadmissible']),
    spendKnownness: z.enum(['finite-usd', 'unknown-paid']),
    automaticAllowance: z
      .object({ eligible: z.literal(true), consumed: z.literal(false) })
      .strict(),
    evidence: EvidenceRefSchema,
    diagnostic: z.string().max(RECOVERY_REFUSAL_RETENTION.maxDiagnosticBytes).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.code === 'brief_budget_unknown' && value.category !== 'budget') {
      ctx.addIssue({
        code: 'custom',
        path: ['category'],
        message: 'brief_budget_unknown refusals must use the budget category',
      });
    }
    if (value.code === 'brief_budget_exhausted' && value.category !== 'budget') {
      ctx.addIssue({
        code: 'custom',
        path: ['category'],
        message: 'brief_budget_exhausted refusals must use the budget category',
      });
    }
    if (value.budgetPolicy === 'usd-cap' && value.configuredCap === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['configuredCap'],
        message: 'a USD-cap refusal must retain its configured cap',
      });
    }
    if (value.budgetPolicy === 'no-dollar-cap' && value.configuredCap !== null) {
      ctx.addIssue({
        code: 'custom',
        path: ['configuredCap'],
        message: 'a no-dollar-cap refusal cannot retain a configured cap',
      });
    }
    if (
      value.code === 'brief_budget_unknown' &&
      value.priceKnownness !== 'provider-dependent' &&
      value.priceKnownness !== 'inadmissible'
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['priceKnownness'],
        message: 'unknown-budget refusals must identify an inadmissible price context',
      });
    }
  })
  .strict();
export type RecoveryRefusalReceipt = z.infer<typeof RecoveryRefusalReceiptSchema>;

export const RecoveryRefusalSummarySchema = z
  .object({
    epochId: id,
    closedAt: timestamp,
    finalEvidenceHead: id,
    count: nonNegativeInteger,
    refusalSetDigest: hash,
  })
  .strict();
export type RecoveryRefusalSummary = z.infer<typeof RecoveryRefusalSummarySchema>;

function utf8Bytes(value: unknown): number {
  const serialized = JSON.stringify(value);
  return serialized === undefined ? 0 : Buffer.byteLength(serialized, 'utf8');
}

export const RecoveryRefusalRetentionSchema = z
  .object({
    version: z.literal(RECOVERY_REFUSAL_RETENTION.version),
    currentEpochId: id,
    refusals: z.record(id, RecoveryRefusalReceiptSchema),
    closedEpochSummaries: z
      .array(RecoveryRefusalSummarySchema)
      .max(RECOVERY_REFUSAL_RETENTION.maxClosedEpochSummaries),
  })
  .superRefine((value, ctx) => {
    const refusalEntries = Object.entries(value.refusals);
    if (refusalEntries.length > RECOVERY_REFUSAL_RETENTION.maxCurrentEpochRecords) {
      ctx.addIssue({
        code: 'too_big',
        maximum: RECOVERY_REFUSAL_RETENTION.maxCurrentEpochRecords,
        origin: 'array',
        path: ['refusals'],
        message: 'current-epoch refusal retention is full',
      });
    }
    let refusalBytes = 0;
    let evidenceBytes = 0;
    for (const [operationId, refusal] of refusalEntries) {
      if (operationId !== refusal.operationId) {
        ctx.addIssue({
          code: 'custom',
          path: ['refusals', operationId],
          message: 'refusal map keys must equal operation IDs',
        });
      }
      if (refusal.epochId !== value.currentEpochId) {
        ctx.addIssue({
          code: 'custom',
          path: ['refusals', operationId, 'epochId'],
          message: 'current refusal records must match currentEpochId',
        });
      }
      const receiptBytes = utf8Bytes(refusal);
      refusalBytes += receiptBytes;
      evidenceBytes += utf8Bytes(refusal.evidence);
      if (receiptBytes > RECOVERY_REFUSAL_RETENTION.maxReceiptBytes) {
        ctx.addIssue({
          code: 'too_big',
          maximum: RECOVERY_REFUSAL_RETENTION.maxReceiptBytes,
          origin: 'number',
          path: ['refusals', operationId],
          message: 'refusal receipt exceeds its byte bound',
        });
      }
    }
    if (refusalBytes > RECOVERY_REFUSAL_RETENTION.maxCurrentEpochBytes) {
      ctx.addIssue({
        code: 'too_big',
        maximum: RECOVERY_REFUSAL_RETENTION.maxCurrentEpochBytes,
        origin: 'number',
        path: ['refusals'],
        message: 'current refusal retention exceeds its byte bound',
      });
    }
    if (evidenceBytes > RECOVERY_REFUSAL_RETENTION.maxCurrentEpochEvidenceBytes) {
      ctx.addIssue({
        code: 'too_big',
        maximum: RECOVERY_REFUSAL_RETENTION.maxCurrentEpochEvidenceBytes,
        origin: 'number',
        path: ['refusals'],
        message: 'current refusal evidence exceeds its byte bound',
      });
    }
    const summaryBytes = utf8Bytes(value.closedEpochSummaries);
    if (summaryBytes > RECOVERY_REFUSAL_RETENTION.maxClosedEpochBytes) {
      ctx.addIssue({
        code: 'too_big',
        maximum: RECOVERY_REFUSAL_RETENTION.maxClosedEpochBytes,
        origin: 'number',
        path: ['closedEpochSummaries'],
        message: 'closed refusal summaries exceed their byte bound',
      });
    }
    for (const [index, summary] of value.closedEpochSummaries.entries()) {
      if (utf8Bytes(summary) > RECOVERY_REFUSAL_RETENTION.maxClosedEpochSummaryBytes) {
        ctx.addIssue({
          code: 'too_big',
          maximum: RECOVERY_REFUSAL_RETENTION.maxClosedEpochSummaryBytes,
          origin: 'number',
          path: ['closedEpochSummaries', index],
          message: 'closed refusal summary exceeds its byte bound',
        });
      }
    }
  })
  .strict();
export type RecoveryRefusalRetention = z.infer<typeof RecoveryRefusalRetentionSchema>;
