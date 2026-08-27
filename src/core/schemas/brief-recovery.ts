import { z } from 'zod';
import {
  InputReceiptSchema,
  type PlannerAttemptSettlement,
  RecoveryReceiptSchema,
} from './brief-recovery/attempt.js';
import {
  type BriefRecoveryInspection,
  type BriefRecoveryProjectionV1,
  BriefRecoveryProjectionV1Schema,
} from './brief-recovery/document.js';
import {
  BriefContinuationV1Schema,
  BriefQualityReportEvidenceSchema,
  BriefRecoveryOriginSchema,
  EvidenceRefSchema,
  MAX_BRIEF,
  MAX_INPUTS,
  hash,
  id,
  message,
  nonNegativeInteger,
} from './brief-recovery/primitives.js';

export const BriefAdmissionInputSchema = z
  .object({
    sessionId: id,
    origin: BriefRecoveryOriginSchema,
    continuation: BriefContinuationV1Schema,
    activeBrief: EvidenceRefSchema,
    report: BriefQualityReportEvidenceSchema,
    qualityPolicyVersion: id,
  })
  .superRefine((value, ctx) => {
    if (value.report.briefHash !== value.activeBrief.hash) {
      ctx.addIssue({
        code: 'custom',
        path: ['report', 'briefHash'],
        message: 'report must identify the admitted Brief',
      });
    }
    if (
      value.continuation.kind === 'approval' &&
      (value.continuation.mode !== value.origin.mode ||
        (value.origin.mode !== 'standard' && value.origin.mode !== 'speckit'))
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['continuation'],
        message: 'approval continuation must match standard or speckit origin',
      });
    }
  })
  .strict();
export type BriefAdmissionInput = z.infer<typeof BriefAdmissionInputSchema>;

export const QueueBriefInputSchema = z
  .object({
    sessionId: id,
    epochId: id,
    inputId: id,
    sequence: z.number().int().positive(),
    kind: z.enum(['feedback', 'edit', 'native-injection']),
    source: z.enum(['interactive', 'typed', 'rpc', 'headless', 'native-injection']),
    payload: z.string().min(1).max(MAX_BRIEF),
    base: EvidenceRefSchema,
    operationId: id.nullable(),
  })
  .strict();
export type QueueBriefInput = z.infer<typeof QueueBriefInputSchema>;

export const BriefRecoveryMigrationInputSchema = z
  .object({
    sessionId: id,
    rawState: z.unknown(),
    artifacts: z
      .object({
        brief: z.unknown(),
        report: z.unknown(),
        queuedInputs: z.unknown(),
      })
      .strict(),
  })
  .strict();
export type BriefRecoveryMigrationInput = z.infer<typeof BriefRecoveryMigrationInputSchema>;

export const StateAuthorityReceiptSchema = z
  .object({
    kind: z.literal('usable'),
    sessionId: id,
    ownerId: id,
    pid: nonNegativeInteger,
    processStart: id,
    runId: id,
    acquisitionId: id,
    fence: nonNegativeInteger,
    stateRevision: nonNegativeInteger,
    stateDigest: hash,
  })
  .strict();
export type StateAuthorityReceipt = z.infer<typeof StateAuthorityReceiptSchema>;

const commandEnvelopeShape = {
  version: z.literal(1),
  sessionId: id,
  epochId: id,
  operationId: id,
  base: EvidenceRefSchema,
  intentHash: hash,
} as const;

export const BriefRecoveryCommandSchema = z.discriminatedUnion('action', [
  z
    .object({
      ...commandEnvelopeShape,
      action: z.literal('retry'),
      diagnosticFingerprint: hash,
      frozenInputIds: z.array(id).max(MAX_INPUTS).readonly(),
      attemptKind: z.literal('feedback-revision').optional(),
    })
    .strict(),
  z
    .object({
      ...commandEnvelopeShape,
      action: z.literal('edit'),
      briefText: z.string().min(1).max(MAX_BRIEF),
      newInputId: id,
    })
    .strict(),
  z.object({ ...commandEnvelopeShape, action: z.literal('reject'), userIntentId: id }).strict(),
  z.object({ ...commandEnvelopeShape, action: z.literal('approve') }).strict(),
  z
    .object({
      ...commandEnvelopeShape,
      action: z.literal('resolve-unresolved'),
      heldInputIds: z.array(id).min(1).max(MAX_INPUTS).readonly(),
      resolution: z.discriminatedUnion('kind', [
        z
          .object({ kind: z.literal('rebind'), acknowledgeRemoteDuplicationRisk: z.literal(true) })
          .strict(),
        z.object({ kind: z.literal('abandon') }).strict(),
      ]),
    })
    .strict(),
  z
    .object({ version: z.literal(1), sessionId: id, epochId: id, action: z.literal('status') })
    .strict(),
]);
export type BriefRecoveryCommand = z.infer<typeof BriefRecoveryCommandSchema>;

const resultBase = {
  version: z.literal(1),
  sessionId: id,
  epochId: id.nullable(),
  projection: BriefRecoveryProjectionV1Schema,
} as const;

const resultReceipt = { operationId: id, receipt: RecoveryReceiptSchema } as const;
const recoveryAcceptedSchema = z
  .object({ ...resultBase, kind: z.literal('accepted'), ...resultReceipt })
  .strict();
const recoveryReplayedSchema = z
  .object({ ...resultBase, kind: z.literal('replayed'), ...resultReceipt })
  .strict();
const recoveryInFlightSchema = z
  .object({ ...resultBase, kind: z.literal('in-flight'), ...resultReceipt })
  .strict();
const recoveryReadySchema = z
  .object({ ...resultBase, kind: z.literal('ready'), operationId: id.nullable() })
  .strict();
const recoveryBlockedSchema = z
  .object({
    ...resultBase,
    kind: z.literal('blocked'),
    code: z.enum([
      'brief_contract_blocked',
      'brief_readiness_blocked',
      'brief_quality_unavailable',
      'brief_budget_exhausted',
      'brief_budget_unknown',
      'brief_no_progress',
      'brief_storage_invalid',
      'brief_provider_error',
    ]),
    operationId: id.nullable(),
    reason: message.optional(),
  })
  .strict();
const recoveryRejectedSchema = z
  .object({ ...resultBase, kind: z.literal('rejected'), operationId: id.nullable() })
  .strict();
const recoveryUnresolvedSchema = z
  .object({ ...resultBase, kind: z.literal('unresolved'), ...resultReceipt })
  .strict();
const recoveryStaleSchema = z
  .object({ ...resultBase, kind: z.literal('stale-ignored'), ...resultReceipt })
  .strict();
const recoveryConflictSchema = z
  .object({
    ...resultBase,
    kind: z.literal('conflict'),
    code: z.enum(['brief_intent_conflict', 'brief_contract_blocked', 'brief_unresolved']),
    operationId: id.nullable(),
    reason: message,
  })
  .strict();

export const RecoveryResultV1Schema = z.discriminatedUnion('kind', [
  recoveryAcceptedSchema,
  recoveryReplayedSchema,
  recoveryInFlightSchema,
  recoveryReadySchema,
  recoveryBlockedSchema,
  recoveryRejectedSchema,
  recoveryUnresolvedSchema,
  recoveryStaleSchema,
  recoveryConflictSchema,
]);
export type RecoveryResultV1 = z.infer<typeof RecoveryResultV1Schema>;
export type RecoveryResult = RecoveryResultV1;

const queueResultBase = {
  version: z.literal(1),
  sessionId: id,
  epochId: id,
  projection: BriefRecoveryProjectionV1Schema,
} as const;
export const QueueResultV1Schema = z.discriminatedUnion('kind', [
  z.object({ ...queueResultBase, kind: z.literal('accepted'), input: InputReceiptSchema }).strict(),
  z.object({ ...queueResultBase, kind: z.literal('replayed'), input: InputReceiptSchema }).strict(),
  z
    .object({
      ...queueResultBase,
      kind: z.literal('conflict'),
      code: z.literal('brief_intent_conflict'),
      inputId: id,
      reason: message,
    })
    .strict(),
  z
    .object({
      ...queueResultBase,
      kind: z.literal('refused'),
      code: z.enum(['brief_storage_invalid', 'brief_contract_blocked']),
      reason: message,
    })
    .strict(),
]);
export type QueueResultV1 = z.infer<typeof QueueResultV1Schema>;

const migrationResultBase = {
  version: z.literal(1),
  sessionId: id,
  epochId: id.nullable(),
  projection: BriefRecoveryProjectionV1Schema,
} as const;
export const MigrationResultV1Schema = z.discriminatedUnion('kind', [
  z.object({ ...migrationResultBase, kind: z.literal('migrated'), migrated: z.boolean() }).strict(),
  z
    .object({
      ...migrationResultBase,
      kind: z.literal('storage-blocked'),
      code: z.literal('brief_storage_invalid'),
      reason: message,
    })
    .strict(),
  z
    .object({
      ...migrationResultBase,
      kind: z.literal('future-version'),
      code: z.literal('brief_version_invalid'),
      reason: message,
    })
    .strict(),
  z
    .object({
      ...migrationResultBase,
      kind: z.literal('conflict'),
      code: z.literal('brief_intent_conflict'),
      reason: message,
    })
    .strict(),
]);
export type MigrationResultV1 = z.infer<typeof MigrationResultV1Schema>;

export type BriefRecoveryController = {
  inspectBriefRecovery(input: BriefRecoveryInspection): BriefRecoveryProjectionV1;
  enterBriefAdmission(
    input: BriefAdmissionInput,
    authority: StateAuthorityReceipt,
  ): Promise<RecoveryResultV1>;
  dispatchBriefAction(
    command: BriefRecoveryCommand,
    authority: StateAuthorityReceipt,
  ): Promise<RecoveryResultV1>;
  queueBriefInput(input: QueueBriefInput, authority: StateAuthorityReceipt): Promise<QueueResultV1>;
  settlePlannerAttempt(
    input: PlannerAttemptSettlement,
    authority: StateAuthorityReceipt,
  ): Promise<RecoveryResultV1>;
  migrateBriefRecovery(
    input: BriefRecoveryMigrationInput,
    authority: StateAuthorityReceipt,
  ): Promise<MigrationResultV1>;
};
