import { z } from 'zod';
import {
  BudgetAccountingKeySchema,
  BudgetReservationSchema,
  BudgetResourceStateSchema,
  RecoveryUsageSchema,
} from './budget.js';
import {
  BriefQualityIssueSchema,
  DispatchPossibilitySchema,
  EvidenceRefSchema,
  MAX_BRIEF,
  MAX_HISTORY,
  MAX_INPUTS,
  MAX_ISSUES,
  finiteAmount,
  hash,
  id,
  nonNegativeInteger,
  path,
  timestamp,
} from './primitives.js';

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
const RecoveryOutcomeSchema = z.enum([
  'ready',
  'quality-failed',
  'provider-failed',
  'malformed-output',
  'storage-failed',
  'stale-ignored',
]);

const settledReceiptSchema = z
  .object({
    ...attemptBaseShape,
    status: z.literal('settled'),
    dispatchPossibility: DispatchPossibilitySchema,
    remoteObservation: z.enum(['not-dispatched', 'confirmed-final']),
    resultId: id,
    outcome: RecoveryOutcomeSchema,
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

export const outboxEntrySchema = z
  .object({
    eventId: id,
    payloadRef: id,
    acknowledged: z.boolean(),
  })
  .strict();

export const matchingReportSchema = z
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

export const automaticRepairSchema = z
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
  });

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
    outcome: RecoveryOutcomeSchema.nullable(),
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

export const PlannerAttemptSettlementSchema = z
  .object({
    sessionId: id,
    epochId: id,
    operationId: id,
    requestId: id.nullable(),
    dispatchPossibility: DispatchPossibilitySchema,
    remoteObservation: z.enum(['not-dispatched', 'confirmed-final', 'unknown']),
    outcome: RecoveryOutcomeSchema,
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
