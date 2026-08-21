import { z } from 'zod';
import {
  RecoveryOperationEnvelopeSchema,
  TaskCompilationAttemptIdSchema,
  TaskCompilationBatchIdSchema,
  TaskCompilationFailureCodeSchema,
  TaskCompilationFailureSchema,
  TaskCompilationFailureStatusSchema,
  TaskCompilationOperationIdSchema,
  TaskCompilationProgramIdSchema,
  TaskCompilationProgramSchema,
  OwnedPlannerArtifactSchema,
} from './task-compilation.js';

export { RecoveryOperationEnvelopeSchema } from './task-compilation.js';
export type { RecoveryOperationEnvelope } from './task-compilation.js';
export type { BriefRecoveryControllerDeps } from './brief-owner.js';

const MAX_ID = 256;
const MAX_MESSAGE = 4_096;
const MAX_PATH = 4_096;
const MAX_HASH = 512;
const MAX_BRIEF = 1_024 * 1_024;
const MAX_ISSUES = 256;
const MAX_ATTEMPTS = 1_024;
const MAX_INPUTS = 4_096;
const MAX_HISTORY = 256;
const MAX_OUTBOX = 4_096;

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

const id = z.string().min(1).max(MAX_ID);
const message = z.string().trim().min(1).max(MAX_MESSAGE);
const hash = z.string().min(1).max(MAX_HASH);
const path = z.string().min(1).max(MAX_PATH);
const timestamp = z.string().min(1).max(128);
const nonNegativeInteger = z.number().int().nonnegative();
const finiteAmount = z.number().finite().nonnegative();
const signedFiniteAmount = z.number().finite();

export const BRIEF_CONTRACT_STATUSES = [
  'checking',
  'auto-repairing',
  'blocked',
  'storage-blocked',
  'retrying',
  'unresolved',
  'ready',
  'readiness-blocked',
  'rejected',
] as const;
export const BriefContractStatusSchema = z.enum(BRIEF_CONTRACT_STATUSES);
export type BriefContractStatus = z.infer<typeof BriefContractStatusSchema>;
export const BriefRecoveryStatusSchema = BriefContractStatusSchema;

export const DISPATCH_POSSIBILITIES = ['none', 'possible'] as const;
export const DispatchPossibilitySchema = z.enum(DISPATCH_POSSIBILITIES);
export type DispatchPossibility = z.infer<typeof DispatchPossibilitySchema>;

export const BriefRecoveryActionSchema = z.enum([
  'retry',
  'edit',
  'reject',
  'approve',
  'status',
  'resolve-unresolved',
  'revise',
]);
export type BriefRecoveryAction = z.infer<typeof BriefRecoveryActionSchema>;

export const EvidenceRefSchema = z
  .object({
    revision: nonNegativeInteger,
    hash,
    path,
  })
  .strict();
export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;

export const BriefRecoveryOriginSchema = z
  .object({
    mode: z.enum(['standard', 'speckit', 'instant', 'quick']),
    entry: z.enum(['initial', 'rewind', 'regenerated-plan', 'auto-split']),
  })
  .strict();
export type BriefRecoveryOrigin = z.infer<typeof BriefRecoveryOriginSchema>;

const approvalContinuationSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal('approval'),
    mode: z.enum(['standard', 'speckit']),
    entry: z.enum(['initial', 'rewind', 'regenerated-plan', 'auto-split']),
  })
  .strict();
const speckitAnalysisContinuationSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal('speckit-analysis'),
    entry: z.enum(['initial', 'rewind', 'regenerated-plan']),
  })
  .strict();
const instantContinuationSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal('instant-start'),
    entry: z.enum(['initial', 'rewind', 'regenerated-plan']),
  })
  .strict();
const quickContinuationSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal('quick-start'),
    entry: z.enum(['initial', 'rewind', 'regenerated-plan']),
  })
  .strict();

export const BriefContinuationV1Schema = z.discriminatedUnion('kind', [
  approvalContinuationSchema,
  speckitAnalysisContinuationSchema,
  instantContinuationSchema,
  quickContinuationSchema,
]);
export type BriefContinuationV1 = z.infer<typeof BriefContinuationV1Schema>;

export const BriefQualityIssueSchema = z
  .object({
    code: id,
    severity: z.enum(['error', 'warning']),
    taskId: id.nullable(),
    message,
  })
  .strict();
export type BriefQualityIssue = z.infer<typeof BriefQualityIssueSchema>;

export const BriefQualityReportEvidenceSchema = z
  .object({
    briefHash: hash,
    report: EvidenceRefSchema,
    ruleVersion: id,
    issues: z.array(BriefQualityIssueSchema).max(MAX_ISSUES).readonly(),
    errorCount: nonNegativeInteger,
  })
  .superRefine((value, ctx) => {
    const actual = value.issues.filter((issue) => issue.severity === 'error').length;
    if (value.errorCount !== actual) {
      ctx.addIssue({
        code: 'custom',
        path: ['errorCount'],
        message: 'errorCount must equal the number of error issues',
      });
    }
  })
  .strict();
export type BriefQualityReportEvidence = z.infer<typeof BriefQualityReportEvidenceSchema>;

export const RecoveryUsageSchema = z
  .object({
    inputTokens: nonNegativeInteger,
    outputTokens: nonNegativeInteger,
    totalTokens: nonNegativeInteger,
    estimated: z.boolean(),
  })
  .superRefine((value, ctx) => {
    if (value.totalTokens !== value.inputTokens + value.outputTokens) {
      ctx.addIssue({
        code: 'custom',
        path: ['totalTokens'],
        message: 'totalTokens must equal inputTokens plus outputTokens',
      });
    }
  })
  .strict();
export type RecoveryUsage = z.infer<typeof RecoveryUsageSchema>;

export const FrozenPricingSchema = z
  .object({
    budgetUnit: z.literal('usd'),
    pricingIdentity: id,
    inputPer1M: finiteAmount,
    outputPer1M: finiteAmount,
  })
  .strict();
export type FrozenPricing = z.infer<typeof FrozenPricingSchema>;

export const RecoveryBudgetResourceSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('finite-usd'),
      accountingKey: id,
      amount: finiteAmount,
      envelope: RecoveryOperationEnvelopeSchema,
      pricing: FrozenPricingSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('provider-dependent'),
      accountingKey: id,
      pricingIdentity: id,
      envelope: RecoveryOperationEnvelopeSchema,
      observedUsage: RecoveryUsageSchema.nullable(),
      resolvedPricing: FrozenPricingSchema.nullable(),
    })
    .strict(),
]);
export type RecoveryBudgetResource = z.infer<typeof RecoveryBudgetResourceSchema>;

export const BUDGET_RESOURCE_STATES = [
  'reserved',
  'released',
  'held',
  'reconciled',
  'terminal-charged',
] as const;
export const BudgetResourceStateSchema = z.enum(BUDGET_RESOURCE_STATES);

export const BudgetResourceEventSchema = z
  .object({
    state: BudgetResourceStateSchema,
    at: timestamp,
    reason: z.enum([
      'accepted',
      'interrupted',
      'confirmed-final',
      'unresolved',
      'superseded',
      'rebind',
      'abandon',
      'terminal-accounting',
    ]),
  })
  .strict();

export const BudgetAccountingKeySchema = z
  .object({
    sessionId: id,
    epochId: id,
    operationId: id,
    generation: nonNegativeInteger,
  })
  .strict();
export type BudgetAccountingKey = z.infer<typeof BudgetAccountingKeySchema>;

export const BudgetReservationSchema = z
  .object({
    accountingKey: BudgetAccountingKeySchema,
    amount: finiteAmount,
    pricing: FrozenPricingSchema.optional(),
    bookedAmount: finiteAmount.optional(),
    state: BudgetResourceStateSchema,
    usageApplied: z.boolean(),
    appliedUsage: RecoveryUsageSchema.nullable(),
    history: z.array(BudgetResourceEventSchema).max(MAX_HISTORY).readonly(),
  })
  .superRefine((value, ctx) => {
    if (value.state === 'terminal-charged') {
      if (!value.usageApplied || value.appliedUsage !== null) {
        ctx.addIssue({
          code: 'custom',
          path: ['usageApplied'],
          message: 'terminal-charged resources have usageApplied true and no appliedUsage',
        });
      }
      return;
    }
    if (value.usageApplied !== (value.appliedUsage !== null)) {
      ctx.addIssue({
        code: 'custom',
        path: ['appliedUsage'],
        message: 'usageApplied must match whether appliedUsage is present',
      });
    }
    if (value.state === 'reconciled' && !value.usageApplied) {
      ctx.addIssue({
        code: 'custom',
        path: ['state'],
        message: 'reconciled resources must have applied usage',
      });
    }
    if (
      (value.state === 'reserved' || value.state === 'released' || value.state === 'held') &&
      value.usageApplied
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['state'],
        message: 'reserved, released, and held resources cannot have applied usage',
      });
    }
  })
  .strict();
export type BudgetReservation = z.infer<typeof BudgetReservationSchema>;

const attemptBaseShape = {
  epochId: id,
  operationId: id,
  intentHash: hash,
  kind: z.enum(['automatic', 'feedback-revision', 'manual-retry']),
  acceptedAt: timestamp,
  baseBrief: EvidenceRefSchema,
  baseReport: EvidenceRefSchema.nullable(),
  frozenInputIds: z.array(id).max(MAX_INPUTS).readonly(),
  prompt: z.string().max(MAX_BRIEF).optional(),
  projectDir: path.optional(),
  reservation: BudgetReservationSchema,
} as const;
const attemptBaseSchema = z.object(attemptBaseShape).strict();
export type AttemptBase = z.infer<typeof attemptBaseSchema>;

const acceptedReceiptSchema = z
  .object({
    ...attemptBaseShape,
    status: z.literal('accepted'),
    dispatchPossibility: z.literal('none'),
    automaticAllowanceConsumed: z.boolean(),
  })
  .strict();
const startedReceiptSchema = z
  .object({
    ...attemptBaseShape,
    status: z.literal('started'),
    dispatchPossibility: z.literal('possible'),
    startedAt: timestamp,
    requestId: id,
  })
  .strict();
const interruptedReceiptSchema = z
  .object({
    ...attemptBaseShape,
    status: z.literal('interrupted-not-dispatched'),
    dispatchPossibility: z.literal('none'),
    interruptedAt: timestamp,
  })
  .strict();
const unresolvedReceiptSchema = z
  .object({
    ...attemptBaseShape,
    status: z.literal('unresolved'),
    dispatchPossibility: z.literal('possible'),
    remoteObservation: z.literal('unknown'),
    requestId: id,
    unresolvedAt: timestamp,
  })
  .strict();
const settledReceiptSchema = z
  .object({
    ...attemptBaseShape,
    status: z.literal('settled'),
    dispatchPossibility: DispatchPossibilitySchema,
    remoteObservation: z.enum(['not-dispatched', 'confirmed-final']),
    resultId: id,
    outcome: z.enum([
      'ready',
      'quality-failed',
      'provider-failed',
      'malformed-output',
      'storage-failed',
      'stale-ignored',
    ]),
    providerCode: id.nullable(),
    usage: RecoveryUsageSchema.nullable(),
    settledAt: timestamp,
    candidate: EvidenceRefSchema.nullable(),
    report: EvidenceRefSchema.nullable(),
  })
  .superRefine((value, ctx) => {
    if (
      (value.dispatchPossibility === 'none' && value.remoteObservation !== 'not-dispatched') ||
      (value.dispatchPossibility === 'possible' && value.remoteObservation !== 'confirmed-final')
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['remoteObservation'],
        message: 'remoteObservation must agree with dispatchPossibility',
      });
    }
    if (value.outcome === 'provider-failed' && value.providerCode === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['providerCode'],
        message: 'provider-failed outcomes require a provider code',
      });
    }
  })
  .strict();
const supersededReceiptSchema = z
  .object({
    ...attemptBaseShape,
    status: z.literal('superseded'),
    dispatchPossibility: DispatchPossibilitySchema,
    resourceDisposition: z.enum(['released', 'held-superseded']),
    supersededAt: timestamp,
    reason: z.enum(['edit', 'reject', 'new-base']),
  })
  .superRefine((value, ctx) => {
    const expected = value.dispatchPossibility === 'none' ? 'released' : 'held-superseded';
    if (value.resourceDisposition !== expected) {
      ctx.addIssue({
        code: 'custom',
        path: ['resourceDisposition'],
        message: `superseded resources with dispatchPossibility ${value.dispatchPossibility} must be ${expected}`,
      });
    }
  })
  .strict();
const abandonedReceiptSchema = z
  .object({
    ...attemptBaseShape,
    status: z.literal('abandoned'),
    dispatchPossibility: z.literal('possible'),
    resourceDisposition: z.literal('abandoned'),
    abandonedAt: timestamp,
    disposition: z.literal('superseded-by-user'),
  })
  .strict();

export const RecoveryReceiptSchema = z.discriminatedUnion('status', [
  acceptedReceiptSchema,
  startedReceiptSchema,
  interruptedReceiptSchema,
  unresolvedReceiptSchema,
  settledReceiptSchema,
  supersededReceiptSchema,
  abandonedReceiptSchema,
]);
export type RecoveryReceipt = z.infer<typeof RecoveryReceiptSchema>;

export const InputStateSchema = z.enum([
  'queued',
  'bound',
  'released',
  'applied',
  'carried',
  'held',
  'held-superseded',
  'abandoned',
]);
export type InputState = z.infer<typeof InputStateSchema>;

export const InputRemoteObservationSchema = z.enum([
  'not-dispatched',
  'possible',
  'confirmed-final',
]);
const nullableInputRemoteObservationSchema = InputRemoteObservationSchema.nullable();

export const InputLifecycleEventSchema = z
  .object({
    state: InputStateSchema,
    at: timestamp,
    operationId: id.nullable(),
    remoteObservation: nullableInputRemoteObservationSchema,
  })
  .strict();
export type InputLifecycleEvent = z.infer<typeof InputLifecycleEventSchema>;

export const InputReceiptSchema = z
  .object({
    inputId: id,
    epochId: id,
    sequence: z.number().int().positive(),
    kind: z.enum(['feedback', 'edit', 'native-injection']),
    source: z.enum(['interactive', 'typed', 'rpc', 'headless', 'native-injection']),
    payloadRef: EvidenceRefSchema,
    textHash: hash,
    state: InputStateSchema,
    operationId: id.nullable(),
    appliedRevision: nonNegativeInteger.nullable(),
    remoteObservation: nullableInputRemoteObservationSchema,
    history: z.array(InputLifecycleEventSchema).max(MAX_HISTORY).readonly(),
  })
  .superRefine((value, ctx) => {
    if (value.state === 'bound' && value.operationId === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['operationId'],
        message: 'bound input must identify its operation',
      });
    }
    if (value.state === 'applied' && value.appliedRevision === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['appliedRevision'],
        message: 'applied input must identify the applying revision',
      });
    }
  })
  .strict();
export type InputReceipt = z.infer<typeof InputReceiptSchema>;

const outboxEntrySchema = z
  .object({
    eventId: id,
    payloadRef: id,
    acknowledged: z.boolean(),
  })
  .strict();

const matchingReportSchema = z
  .object({
    briefHash: hash,
    report: EvidenceRefSchema,
    ruleVersion: id,
    issues: z.array(BriefQualityIssueSchema).max(MAX_ISSUES).readonly(),
  })
  .strict();

export const BriefReadinessDecisionSchema = z
  .object({
    kind: z.enum(['blocked', 'passed', 'override']),
    fingerprint: hash,
    briefHash: hash,
    reportHash: hash,
    qualityPolicyVersion: id,
  })
  .strict();
export type BriefReadinessDecision = z.infer<typeof BriefReadinessDecisionSchema>;

const automaticRepairSchema = z
  .object({
    policy: z.enum(['existing-one-shot', 'zero-task-only', 'none']),
    eligible: z.boolean(),
    consumed: z.boolean(),
    operationId: id.nullable(),
  })
  .superRefine((value, ctx) => {
    if (
      value.policy === 'none' &&
      (value.eligible || value.consumed || value.operationId !== null)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['policy'],
        message: 'a none automatic-repair policy cannot be eligible, consumed, or active',
      });
    }
    if (!value.consumed && value.operationId !== null) {
      ctx.addIssue({
        code: 'custom',
        path: ['operationId'],
        message: 'an automatic repair operation requires consumed allowance',
      });
    }
  })
  .strict();

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

const normalRecoveryBaseShape = {
  version: z.literal(1),
  recoveryRevision: nonNegativeInteger,
  epochId: id,
  origin: BriefRecoveryOriginSchema,
  continuation: BriefContinuationV1Schema,
  status: z.enum([
    'checking',
    'auto-repairing',
    'blocked',
    'retrying',
    'unresolved',
    'ready',
    'readiness-blocked',
    'rejected',
  ]),
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

export const AttemptSummarySchema = z
  .object({
    operationId: id,
    status: z.enum([
      'accepted',
      'started',
      'interrupted-not-dispatched',
      'unresolved',
      'settled',
      'superseded',
      'abandoned',
    ]),
    dispatchPossibility: DispatchPossibilitySchema,
    outcome: z
      .enum([
        'ready',
        'quality-failed',
        'provider-failed',
        'malformed-output',
        'storage-failed',
        'stale-ignored',
      ])
      .nullable(),
    reservation: z
      .object({
        accountingKey: BudgetAccountingKeySchema,
        amount: finiteAmount,
        state: BudgetResourceStateSchema,
      })
      .strict(),
  })
  .strict();

export const BriefRecoveryQueuedInputsSchema = z
  .object({
    ids: z.array(id).max(MAX_INPUTS).readonly(),
    count: nonNegativeInteger,
    carriedCount: nonNegativeInteger,
    heldCount: nonNegativeInteger,
    releasedCount: nonNegativeInteger,
  })
  .superRefine((value, ctx) => {
    if (value.count !== value.ids.length) {
      ctx.addIssue({ code: 'custom', path: ['count'], message: 'count must equal ids length' });
    }
    if (value.carriedCount + value.heldCount + value.releasedCount > value.count) {
      ctx.addIssue({
        code: 'custom',
        path: ['count'],
        message: 'carried, held, and released counts cannot exceed count',
      });
    }
  })
  .strict();

const projectionMatchingReportSchema = z
  .object({
    briefHash: hash,
    report: EvidenceRefSchema,
    ruleVersion: id,
    issues: z.array(BriefQualityIssueSchema).max(MAX_ISSUES).readonly(),
  })
  .strict();

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
    matchingReport: projectionMatchingReportSchema.nullable(),
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

const recoveryProviderCallSelectionSchema = z
  .object({
    batchId: TaskCompilationBatchIdSchema,
    attemptId: TaskCompilationAttemptIdSchema,
    envelopeDigest: hash,
  })
  .strict();

export const RecoveryProviderAggregateRequestSchema = z
  .object({
    operationId: TaskCompilationOperationIdSchema,
    program: TaskCompilationProgramSchema,
    calls: z.array(recoveryProviderCallSelectionSchema).min(1).max(MAX_ATTEMPTS).readonly(),
  })
  .superRefine((value, ctx) => {
    if (value.calls.length !== value.program.batches.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['calls'],
        message: 'aggregate recovery calls must cover every frozen program batch',
      });
    }
    const batchIds = new Set<string>();
    for (const [index, batch] of value.program.batches.entries()) {
      if (batchIds.has(batch.batchId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['program', 'batches', index, 'batchId'],
          message: 'frozen program batches must have unique IDs',
        });
      }
      batchIds.add(batch.batchId);
    }
    const seenBatches = new Set<string>();
    const seenAttempts = new Set<string>();
    for (const [index, call] of value.calls.entries()) {
      const batchId = call.batchId;
      if (!batchIds.has(call.batchId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['calls', index, 'batchId'],
          message: 'aggregate call batch is not present in the frozen program',
        });
      }
      if (seenBatches.has(batchId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['calls', index, 'batchId'],
          message: 'aggregate recovery calls must not repeat a batch',
        });
      }
      if (seenAttempts.has(call.attemptId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['calls', index, 'attemptId'],
          message: 'aggregate recovery calls must not repeat an attempt',
        });
      }
      seenBatches.add(batchId);
      seenAttempts.add(call.attemptId);
    }
  })
  .strict();
export type RecoveryProviderAggregateRequest = z.infer<
  typeof RecoveryProviderAggregateRequestSchema
>;

const recoveryProviderCallIdentityShape = {
  operationId: TaskCompilationOperationIdSchema,
  programId: TaskCompilationProgramIdSchema,
  batchId: TaskCompilationBatchIdSchema,
  attemptId: TaskCompilationAttemptIdSchema,
  envelopeDigest: hash,
} as const;
const definiteFailureTerminalStatusSchema = TaskCompilationFailureStatusSchema.exclude(['unknown']);

export const RecoveryProviderCallResultSchema = z.discriminatedUnion('kind', [
  z
    .object({
      ...recoveryProviderCallIdentityShape,
      kind: z.literal('not-dispatched'),
      artifact: z.null(),
      usage: z.null(),
      failureCode: TaskCompilationFailureCodeSchema,
    })
    .strict(),
  z
    .object({
      ...recoveryProviderCallIdentityShape,
      kind: z.literal('completed'),
      terminalStatus: z.literal('completed'),
      artifact: OwnedPlannerArtifactSchema,
      usage: RecoveryUsageSchema.nullable(),
      failureCode: z.null(),
    })
    .strict(),
  z
    .object({
      ...recoveryProviderCallIdentityShape,
      kind: z.literal('failed'),
      terminalStatus: definiteFailureTerminalStatusSchema,
      artifact: z.null(),
      usage: RecoveryUsageSchema.nullable(),
      failureCode: TaskCompilationFailureCodeSchema,
    })
    .strict(),
  z
    .object({
      ...recoveryProviderCallIdentityShape,
      kind: z.literal('unknown'),
      terminalStatus: z.literal('unknown'),
      artifact: z.null(),
      usage: RecoveryUsageSchema.nullable(),
      failureCode: TaskCompilationFailureCodeSchema,
    })
    .strict(),
]);
export type RecoveryProviderCallResult = z.infer<typeof RecoveryProviderCallResultSchema>;

const recoveryProviderResultBaseShape = {
  operationId: TaskCompilationOperationIdSchema,
  programId: TaskCompilationProgramIdSchema,
  operationEnvelopeDigest: hash,
  calls: z.array(RecoveryProviderCallResultSchema).min(1).max(MAX_ATTEMPTS).readonly(),
} as const;

const recoveryProviderAggregateResultSchema = z
  .discriminatedUnion('kind', [
    z
      .object({
        ...recoveryProviderResultBaseShape,
        kind: z.literal('compiled'),
        candidate: z.unknown(),
        usage: RecoveryUsageSchema.nullable(),
      })
      .strict(),
    z
      .object({
        ...recoveryProviderResultBaseShape,
        kind: z.enum(['definite-failure', 'ambiguous-failure']),
        failure: TaskCompilationFailureSchema,
        usage: RecoveryUsageSchema.nullable(),
      })
      .strict(),
  ])
  .superRefine((value, ctx) => {
    const seenAttempts = new Set<string>();
    for (const [index, call] of value.calls.entries()) {
      if (call.operationId !== value.operationId || call.programId !== value.programId) {
        ctx.addIssue({
          code: 'custom',
          path: ['calls', index],
          message: 'aggregate result call identity must match its result',
        });
      }
      if (seenAttempts.has(call.attemptId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['calls', index, 'attemptId'],
          message: 'aggregate result attempts must be unique',
        });
      }
      seenAttempts.add(call.attemptId);
      if (call.kind === 'completed') {
        const artifact = call.artifact;
        if (
          artifact.programId !== value.programId ||
          artifact.batchId !== call.batchId ||
          artifact.attemptId !== call.attemptId
        ) {
          ctx.addIssue({
            code: 'custom',
            path: ['calls', index, 'artifact'],
            message: 'completed artifact identity must match its call result',
          });
        }
      }
    }
    if (value.kind === 'compiled') {
      if (value.candidate === null || typeof value.candidate !== 'object') {
        ctx.addIssue({
          code: 'custom',
          path: ['candidate'],
          message: 'compiled aggregate results require a materialized candidate',
        });
      }
      if (value.calls.some((call) => call.kind !== 'completed')) {
        ctx.addIssue({
          code: 'custom',
          path: ['calls'],
          message: 'compiled aggregate results require every call to complete',
        });
      }
      return;
    }
    const hasUnknown = value.calls.some((call) => call.kind === 'unknown');
    if (value.kind === 'ambiguous-failure' && !hasUnknown) {
      ctx.addIssue({
        code: 'custom',
        path: ['calls'],
        message: 'ambiguous aggregate failures require an unknown call result',
      });
    }
    if (value.kind === 'definite-failure' && hasUnknown) {
      ctx.addIssue({
        code: 'custom',
        path: ['calls'],
        message: 'definite aggregate failures cannot contain unknown call results',
      });
    }
  });
export type RecoveryProviderAggregateResult = z.infer<typeof recoveryProviderAggregateResultSchema>;

function recoveryProviderCallIdentityKey(call: {
  batchId: string;
  attemptId: string;
  envelopeDigest: string;
}): string {
  return JSON.stringify([call.batchId, call.attemptId, call.envelopeDigest]);
}

function refineRecoveryProviderAggregateResultForRequest(
  result: RecoveryProviderAggregateResult,
  request: RecoveryProviderAggregateRequest,
  ctx: z.RefinementCtx,
): void {
  if (result.operationId !== request.operationId) {
    ctx.addIssue({
      code: 'custom',
      path: ['operationId'],
      message: 'aggregate result operation ID must match the frozen request',
    });
  }
  if (result.programId !== request.program.programId) {
    ctx.addIssue({
      code: 'custom',
      path: ['programId'],
      message: 'aggregate result program ID must match the frozen request',
    });
  }
  if (result.operationEnvelopeDigest !== request.program.operationEnvelope.callsDigest) {
    ctx.addIssue({
      code: 'custom',
      path: ['operationEnvelopeDigest'],
      message: 'aggregate result operation envelope must match the frozen request',
    });
  }

  const expectedByBatch = new Map(request.calls.map((call) => [call.batchId, call] as const));
  const expectedKeys = new Set(request.calls.map(recoveryProviderCallIdentityKey));
  const seenKeys = new Set<string>();
  const seenBatches = new Set<string>();

  for (const [index, call] of result.calls.entries()) {
    const key = recoveryProviderCallIdentityKey(call);
    if (seenKeys.has(key)) {
      ctx.addIssue({
        code: 'custom',
        path: ['calls', index],
        message: 'aggregate result call identities must be unique',
      });
    }
    seenKeys.add(key);

    const expected = expectedByBatch.get(call.batchId);
    if (expected === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['calls', index, 'batchId'],
        message: 'aggregate result batch is not present in the frozen request',
      });
      continue;
    }
    if (seenBatches.has(call.batchId)) {
      ctx.addIssue({
        code: 'custom',
        path: ['calls', index, 'batchId'],
        message: 'aggregate result batches must be one-to-one with the frozen request',
      });
    }
    seenBatches.add(call.batchId);
    if (call.attemptId !== expected.attemptId) {
      ctx.addIssue({
        code: 'custom',
        path: ['calls', index, 'attemptId'],
        message: 'aggregate result attempt must match the frozen request',
      });
    }
    if (call.envelopeDigest !== expected.envelopeDigest) {
      ctx.addIssue({
        code: 'custom',
        path: ['calls', index, 'envelopeDigest'],
        message: 'aggregate result envelope must match the frozen request',
      });
    }
  }

  for (const [index, expected] of request.calls.entries()) {
    if (!seenKeys.has(recoveryProviderCallIdentityKey(expected))) {
      ctx.addIssue({
        code: 'custom',
        path: ['calls'],
        message: `aggregate result is missing frozen call ${index + 1}`,
      });
    }
  }
  for (const key of seenKeys) {
    if (!expectedKeys.has(key)) {
      ctx.addIssue({
        code: 'custom',
        path: ['calls'],
        message: 'aggregate result contains an unexpected frozen call identity',
      });
      break;
    }
  }
}

export function createRecoveryProviderAggregateResultSchema(
  request: RecoveryProviderAggregateRequest,
) {
  return recoveryProviderAggregateResultSchema.superRefine((result, ctx) => {
    refineRecoveryProviderAggregateResultForRequest(result, request, ctx);
  });
}

export const RecoveryProviderRequestV1Schema = RecoveryProviderAggregateRequestSchema;
export type RecoveryProviderResultV1 = RecoveryProviderAggregateResult;

export function parseRecoveryProviderResultV1(
  request: unknown,
  input: unknown,
): RecoveryProviderResultV1 {
  const parsedRequest = RecoveryProviderRequestV1Schema.parse(request);
  return createRecoveryProviderAggregateResultSchema(parsedRequest).parse(input);
}

export const PlannerAttemptSettlementSchema = z
  .object({
    sessionId: id,
    epochId: id,
    operationId: id,
    requestId: id.nullable(),
    dispatchPossibility: DispatchPossibilitySchema,
    remoteObservation: z.enum(['not-dispatched', 'confirmed-final', 'unknown']),
    outcome: z.enum([
      'ready',
      'quality-failed',
      'provider-failed',
      'malformed-output',
      'storage-failed',
      'stale-ignored',
    ]),
    candidate: EvidenceRefSchema.nullable(),
    report: EvidenceRefSchema.nullable(),
    providerCode: id.nullable(),
    usage: RecoveryUsageSchema.nullable(),
    settledAt: timestamp,
  })
  .superRefine((value, ctx) => {
    if (value.dispatchPossibility === 'none' && value.remoteObservation !== 'not-dispatched') {
      ctx.addIssue({
        code: 'custom',
        path: ['remoteObservation'],
        message: 'none dispatch can only have not-dispatched observation',
      });
    }
    if (value.dispatchPossibility === 'possible' && value.remoteObservation === 'not-dispatched') {
      ctx.addIssue({
        code: 'custom',
        path: ['remoteObservation'],
        message: 'possible dispatch cannot have not-dispatched observation',
      });
    }
    if (value.remoteObservation === 'unknown' && value.dispatchPossibility !== 'possible') {
      ctx.addIssue({
        code: 'custom',
        path: ['dispatchPossibility'],
        message: 'unknown remote observation requires possible dispatch',
      });
    }
  })
  .strict();
export type PlannerAttemptSettlement = z.infer<typeof PlannerAttemptSettlementSchema>;

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

export const RecoveryProviderRequestSchema = z
  .object({
    sessionId: id,
    epochId: id,
    operationId: id,
    requestId: id,
    prompt: z.string().max(MAX_BRIEF),
    projectDir: path,
    signal: z.unknown().optional(),
  })
  .strict();
export type RecoveryProviderRequest = z.infer<typeof RecoveryProviderRequestSchema>;

export const RecoveryProviderResultSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('completed'),
      requestId: id.nullable(),
      dispatchPossibility: z.literal('possible'),
      remoteObservation: z.literal('confirmed-final'),
      text: z.string().max(MAX_BRIEF),
      providerCode: id.nullable(),
      usage: RecoveryUsageSchema.nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('definite-failure'),
      requestId: id.nullable(),
      dispatchPossibility: DispatchPossibilitySchema,
      remoteObservation: z.enum(['not-dispatched', 'confirmed-final']),
      text: z.null(),
      providerCode: id,
      usage: RecoveryUsageSchema.nullable(),
    })
    .superRefine((value, ctx) => {
      if (value.dispatchPossibility === 'none' && value.remoteObservation !== 'not-dispatched') {
        ctx.addIssue({
          code: 'custom',
          path: ['remoteObservation'],
          message: 'definite dispatch mismatch',
        });
      }
      if (
        value.dispatchPossibility === 'possible' &&
        value.remoteObservation !== 'confirmed-final'
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['remoteObservation'],
          message: 'definite dispatch mismatch',
        });
      }
    })
    .strict(),
  z
    .object({
      kind: z.literal('ambiguous-failure'),
      requestId: id,
      dispatchPossibility: z.literal('possible'),
      remoteObservation: z.literal('unknown'),
      text: z.null(),
      providerCode: id,
      usage: RecoveryUsageSchema.nullable(),
    })
    .strict(),
]);
export type RecoveryProviderResult = z.infer<typeof RecoveryProviderResultSchema>;

export const RecoveryEstimateInputSchema = z
  .object({
    prompt: z.string().max(MAX_BRIEF),
    plannerTool: id,
    plannerModel: id.optional(),
    configuredOutputCap: nonNegativeInteger.optional(),
    pricingCache: z.unknown().optional(),
  })
  .strict();
export type RecoveryEstimateInput = z.infer<typeof RecoveryEstimateInputSchema>;

export const RecoveryCallEstimateSchema = z
  .object({
    kind: z.enum(['finite', 'unavailable']),
    budgetUnit: z.literal('usd'),
    inputTokens: nonNegativeInteger,
    outputTokens: nonNegativeInteger,
    amount: finiteAmount.nullable(),
    pricingIdentity: id,
  })
  .superRefine((value, ctx) => {
    if (value.kind === 'finite' && value.amount === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['amount'],
        message: 'finite estimates require an amount',
      });
    }
    if (value.kind === 'unavailable' && value.amount !== null) {
      ctx.addIssue({
        code: 'custom',
        path: ['amount'],
        message: 'unavailable estimates cannot reserve an amount',
      });
    }
  })
  .strict();
export type RecoveryCallEstimate = z.infer<typeof RecoveryCallEstimateSchema>;

export const RecoveryReservationInputSchema = z
  .object({
    accountingKey: BudgetAccountingKeySchema,
    estimate: RecoveryCallEstimateSchema,
    currentKnownSpend: finiteAmount,
    activeReservations: z.array(BudgetReservationSchema).max(MAX_ATTEMPTS).readonly(),
    maxBudget: finiteAmount.optional(),
  })
  .strict();
export type RecoveryReservationInput = z.infer<typeof RecoveryReservationInputSchema>;

export const RecoveryReservationDecisionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('reserved'), reservation: BudgetReservationSchema }).strict(),
  z
    .object({
      kind: z.literal('refused'),
      code: z.enum(['brief_budget_exhausted', 'brief_budget_unknown']),
      reason: message,
    })
    .strict(),
]);
export type RecoveryReservationDecision = z.infer<typeof RecoveryReservationDecisionSchema>;

export const RecoveryReconciliationInputSchema = z
  .object({
    accountingKey: BudgetAccountingKeySchema,
    reservation: BudgetReservationSchema,
    usage: RecoveryUsageSchema.nullable(),
    remoteObservation: z.enum(['not-dispatched', 'confirmed-final', 'unknown']),
  })
  .strict();
export type RecoveryReconciliationInput = z.infer<typeof RecoveryReconciliationInputSchema>;

export const RecoveryReconciliationSchema = z
  .object({
    reservation: BudgetReservationSchema,
    usageApplied: z.boolean(),
    appliedAmount: signedFiniteAmount,
  })
  .strict();
export type RecoveryReconciliation = z.infer<typeof RecoveryReconciliationSchema>;

export const RecoveryTerminalChargeInputSchema = z
  .object({ accountingKey: BudgetAccountingKeySchema, reservation: BudgetReservationSchema })
  .strict();
export type RecoveryTerminalChargeInput = z.infer<typeof RecoveryTerminalChargeInputSchema>;

export type BriefRecoveryProviderPort = {
  dispatch(input: RecoveryProviderRequest): Promise<RecoveryProviderResult>;
};

export type BriefRecoveryBudgetPort = {
  estimate(input: RecoveryEstimateInput): RecoveryCallEstimate;
  reserve(input: RecoveryReservationInput): RecoveryReservationDecision;
  reconcile(input: RecoveryReconciliationInput): RecoveryReconciliation;
  terminalCharge(input: RecoveryTerminalChargeInput): RecoveryReconciliation;
};

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
