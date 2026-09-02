import { z } from 'zod';
import { PhaseSchema } from '../../core/schemas/enums.js';
import {
  BriefContractStatusSchema,
  BriefRecoveryActionSchema,
  DispatchPossibilitySchema,
} from '../../core/schemas/brief-recovery/primitives.js';
import {
  BriefGenerationRefSchema,
  TaskExecutionPermitSchema,
} from '../../core/schemas/brief-owner.js';

const MAX_RECOVERY_EVENT_IDENTIFIER_LENGTH = 256;
const MAX_RECOVERY_EVENT_CODE_LENGTH = 128;
const MAX_RECOVERY_EVENT_COUNT = 1_000_000;
const MAX_RECOVERY_EVENT_CODES = 256;

const recoveryEventIdentifier = z
  .string()
  .min(1)
  .max(MAX_RECOVERY_EVENT_IDENTIFIER_LENGTH)
  .regex(/^\S+$/u)
  .refine(
    (value) =>
      ![...value].some((character) => {
        const codePoint = character.codePointAt(0);
        return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
      }),
  );
const recoveryEventCode = z
  .string()
  .min(1)
  .max(MAX_RECOVERY_EVENT_CODE_LENGTH)
  .regex(/^[A-Za-z0-9_.:-]+$/u);
const recoveryEventHash = z.string().regex(/^[a-f0-9]{64}$/iu);
const recoveryEventRevision = z.number().int().nonnegative().max(MAX_RECOVERY_EVENT_COUNT);
const recoveryEventCount = recoveryEventRevision;
const recoveryEventCodes = z.array(recoveryEventCode).max(MAX_RECOVERY_EVENT_CODES);

const recoveryEventAttemptKind = z.enum(['automatic', 'feedback-revision', 'manual-retry']);

const recoveryEventRefFields = {
  briefRevision: recoveryEventRevision,
  briefHash: recoveryEventHash,
  reportRevision: recoveryEventRevision.nullable(),
  reportHash: recoveryEventHash.nullable(),
} as const;

const recoveryRefusalCategory = z.enum([
  'quality',
  'provider',
  'authentication',
  'quota',
  'abort',
  'timeout',
  'transport',
  'budget',
  'no-progress',
  'storage',
  'unresolved',
  'stale',
  'intent-conflict',
  'user-rejected',
]);

function briefRecoveryEvent<T extends string, F extends z.ZodRawShape>(type: T, fields: F) {
  return z.strictObject({
    type: z.literal(type),
    ts: z.number().int().nonnegative(),
    phase: PhaseSchema,
    version: z.literal(1),
    eventId: recoveryEventIdentifier,
    sessionId: recoveryEventIdentifier,
    epochId: recoveryEventIdentifier,
    recoveryRevision: recoveryEventRevision,
    ...fields,
  });
}

export const briefRecoveryEventSchemas = [
  briefRecoveryEvent('brief_recovery_quality_reported', {
    ...recoveryEventRefFields,
    reportRevision: recoveryEventRevision,
    reportHash: recoveryEventHash,
    status: BriefContractStatusSchema,
    outcome: z.enum(['passed', 'failed']),
    taskCount: recoveryEventCount,
    issueCount: recoveryEventCount,
    errorCount: recoveryEventCount,
    warningCount: recoveryEventCount,
    issueCodes: recoveryEventCodes,
    score: z.number().finite().min(0).max(1).optional(),
    topIssueCode: recoveryEventCode.optional(),
    automaticRepairPolicy: z.enum(['existing-one-shot', 'zero-task-only', 'none']).optional(),
    automaticRepairConsumed: z.boolean().optional(),
  }),
  briefRecoveryEvent('brief_recovery_auto_repair_exhausted', {
    ...recoveryEventRefFields,
    reportRevision: recoveryEventRevision,
    reportHash: recoveryEventHash,
    operationId: recoveryEventIdentifier,
    intentHash: recoveryEventHash,
    attemptKind: z.literal('automatic'),
    status: z.literal('blocked'),
    refusalCategory: z.literal('quality'),
    automaticRepairConsumed: z.literal(true),
    taskCount: recoveryEventCount,
    issueCount: recoveryEventCount,
    errorCount: recoveryEventCount,
    warningCount: recoveryEventCount,
    issueCodes: recoveryEventCodes,
  }),
  briefRecoveryEvent('brief_recovery_attempt_accepted', {
    ...recoveryEventRefFields,
    operationId: recoveryEventIdentifier,
    intentHash: recoveryEventHash,
    attemptKind: recoveryEventAttemptKind,
    status: z.literal('accepted'),
    dispatchPossibility: z.literal('none'),
    frozenInputCount: recoveryEventCount,
    queuedInputCount: recoveryEventCount,
    automaticAllowanceConsumed: z.boolean(),
  }),
  briefRecoveryEvent('brief_recovery_attempt_started', {
    ...recoveryEventRefFields,
    operationId: recoveryEventIdentifier,
    intentHash: recoveryEventHash,
    attemptKind: recoveryEventAttemptKind,
    status: z.literal('started'),
    requestId: recoveryEventIdentifier,
    dispatchPossibility: z.literal('possible'),
    frozenInputCount: recoveryEventCount,
  }),
  briefRecoveryEvent('brief_recovery_attempt_settled', {
    ...recoveryEventRefFields,
    operationId: recoveryEventIdentifier,
    intentHash: recoveryEventHash,
    attemptKind: recoveryEventAttemptKind,
    status: z.literal('settled'),
    resultId: recoveryEventIdentifier,
    outcome: z.enum([
      'ready',
      'quality-failed',
      'provider-failed',
      'malformed-output',
      'storage-failed',
      'stale-ignored',
    ]),
    dispatchPossibility: DispatchPossibilitySchema,
    remoteObservation: z.enum(['not-dispatched', 'confirmed-final']),
    providerCode: recoveryEventCode.nullable().optional(),
    refusalCategory: recoveryRefusalCategory.optional(),
    taskCount: recoveryEventCount.optional(),
    issueCount: recoveryEventCount.optional(),
    errorCount: recoveryEventCount.optional(),
    warningCount: recoveryEventCount.optional(),
  }),
  briefRecoveryEvent('brief_recovery_attempt_unresolved', {
    ...recoveryEventRefFields,
    operationId: recoveryEventIdentifier,
    intentHash: recoveryEventHash,
    attemptKind: recoveryEventAttemptKind,
    status: z.literal('unresolved'),
    requestId: recoveryEventIdentifier,
    dispatchPossibility: z.literal('possible'),
    remoteObservation: z.literal('unknown'),
    refusalCategory: z.literal('unresolved'),
  }),
  briefRecoveryEvent('brief_recovery_provider_failed', {
    ...recoveryEventRefFields,
    operationId: recoveryEventIdentifier,
    intentHash: recoveryEventHash,
    attemptKind: recoveryEventAttemptKind,
    status: z.literal('blocked'),
    outcome: z.literal('provider-failed'),
    providerCode: recoveryEventCode,
    refusalCategory: z.enum([
      'provider',
      'authentication',
      'quota',
      'abort',
      'timeout',
      'transport',
    ]),
    dispatchPossibility: DispatchPossibilitySchema,
    remoteObservation: z.enum(['not-dispatched', 'confirmed-final']),
  }),
  briefRecoveryEvent('brief_recovery_input_queued', {
    ...recoveryEventRefFields,
    inputId: recoveryEventIdentifier,
    inputSequence: recoveryEventRevision,
    inputKind: z.enum(['feedback', 'edit', 'native-injection']),
    source: z.enum(['interactive', 'typed', 'rpc', 'headless', 'native-injection']),
    textHash: recoveryEventHash,
    operationId: recoveryEventIdentifier.nullable(),
    queuedInputCount: recoveryEventCount,
  }),
  briefRecoveryEvent('brief_recovery_input_applied', {
    ...recoveryEventRefFields,
    inputId: recoveryEventIdentifier,
    inputSequence: recoveryEventRevision,
    inputKind: z.enum(['feedback', 'edit', 'native-injection']),
    source: z.enum(['interactive', 'typed', 'rpc', 'headless', 'native-injection']),
    textHash: recoveryEventHash,
    operationId: recoveryEventIdentifier.nullable(),
    disposition: z.enum(['released', 'applied', 'carried', 'held', 'held-superseded', 'abandoned']),
    appliedRevision: recoveryEventRevision.nullable(),
    queuedInputCount: recoveryEventCount,
  }),
  briefRecoveryEvent('brief_recovery_stale_ignored', {
    operationId: recoveryEventIdentifier,
    intentHash: recoveryEventHash,
    resultId: recoveryEventIdentifier,
    baseBriefRevision: recoveryEventRevision,
    baseBriefHash: recoveryEventHash,
    currentBriefRevision: recoveryEventRevision,
    currentBriefHash: recoveryEventHash,
    baseReportRevision: recoveryEventRevision.nullable(),
    baseReportHash: recoveryEventHash.nullable(),
    currentReportRevision: recoveryEventRevision.nullable(),
    currentReportHash: recoveryEventHash.nullable(),
    refusalCategory: z.literal('stale'),
  }),
  briefRecoveryEvent('brief_recovery_rejected', {
    ...recoveryEventRefFields,
    intentId: recoveryEventIdentifier,
    operationId: recoveryEventIdentifier.nullable(),
    status: z.literal('rejected'),
    disposition: z.literal('user-rejected'),
  }),
  briefRecoveryEvent('brief_recovery_refused', {
    ...recoveryEventRefFields,
    intentId: recoveryEventIdentifier,
    operationId: recoveryEventIdentifier.nullable(),
    action: BriefRecoveryActionSchema,
    refusalCategory: recoveryRefusalCategory,
    refusalCode: recoveryEventCode,
    status: BriefContractStatusSchema,
  }),
  briefRecoveryEvent('brief_recovery_transition', {
    ...recoveryEventRefFields,
    operationId: recoveryEventIdentifier.nullable(),
    status: BriefContractStatusSchema,
  }),
  briefRecoveryEvent('brief_recovery_accepted', {
    ...recoveryEventRefFields,
    operationId: recoveryEventIdentifier,
    intentHash: recoveryEventHash,
    attemptKind: recoveryEventAttemptKind,
    status: z.literal('accepted'),
    dispatchPossibility: z.literal('none'),
    frozenInputCount: recoveryEventCount,
    queuedInputCount: recoveryEventCount,
    automaticAllowanceConsumed: z.boolean(),
  }),
  briefRecoveryEvent('brief_generation_published', {
    operationId: recoveryEventIdentifier,
    generation: BriefGenerationRefSchema,
    provenanceDigest: z.string().min(1).max(512),
  }),
  z
    .strictObject({
      type: z.literal('brief_execution_permit_issued'),
      ts: z.number().int().nonnegative(),
      phase: PhaseSchema,
      version: z.literal(1),
      eventId: recoveryEventIdentifier,
      sessionId: recoveryEventIdentifier,
      epochId: recoveryEventIdentifier,
      recoveryRevision: recoveryEventRevision,
      operationId: recoveryEventIdentifier,
      generation: BriefGenerationRefSchema,
      permit: TaskExecutionPermitSchema,
    })
    .superRefine((value, ctx) => {
      if (value.permit.epochId !== value.epochId) {
        ctx.addIssue({
          code: 'custom',
          path: ['permit', 'epochId'],
          message: 'permit epoch must match the owner event epoch',
        });
      }
      if (
        value.permit.generationId !== value.generation.generationId ||
        value.permit.manifestDigest !== value.generation.manifestDigest ||
        value.permit.tasksDigest !== value.generation.tasksDigest ||
        value.permit.qualityDigest !== value.generation.qualityDigest
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['permit'],
          message: 'permit must identify the published generation',
        });
      }
    }),
] as const;
