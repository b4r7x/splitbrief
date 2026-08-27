import { z } from 'zod';
import type { ConfigRevision } from '../../lib/confined-fs-atomic.js';
import type { RecoveryEvidenceRef } from '../evidence/recovery-journal.js';
import { PhaseSchema } from './enums.js';
import {
  BriefRecoveryStateViewSchema,
  NormalBriefRecoveryV1Schema,
} from './brief-recovery/document.js';
import {
  BriefContractStatusSchema,
  BriefRecoveryActionSchema,
} from './brief-recovery/primitives.js';
import type { BriefRecoveryBudgetPort } from './brief-recovery/budget.js';
import type { BriefRecoveryStateView, NormalBriefRecoveryV1 } from './brief-recovery/document.js';
import type { BriefQualityIssue } from './brief-recovery/primitives.js';
import type { BriefRecoveryProviderPort } from './brief-recovery/provider-call.js';

const nonnegativeInteger = z.number().int().nonnegative();
const boundedId = z.string().min(1).max(256);
const boundedDigest = z.string().min(1).max(512);

const recoveryEvidenceRefSchema = z
  .strictObject({
    revision: z.literal(1),
    hash: boundedDigest,
    path: z.string().min(1).max(2_048),
  })
  .readonly();

export const BriefGenerationRefSchema = z
  .strictObject({
    generationId: boundedId,
    manifestDigest: boundedDigest,
    tasksDigest: boundedDigest,
    qualityDigest: boundedDigest,
    programId: boundedId.nullable(),
  })
  .readonly();
export type BriefGenerationRef = z.infer<typeof BriefGenerationRefSchema>;

export const ConfigRevisionSchema = z
  .strictObject({
    rawSha256: boundedDigest,
    fileIdentity: z
      .strictObject({
        dev: z.bigint().nonnegative(),
        ino: z.bigint().nonnegative(),
        size: z.bigint().nonnegative(),
        mtimeNs: z.bigint().nonnegative(),
      })
      .readonly(),
  })
  .readonly();

export const TaskExecutionPermitSchema = z
  .strictObject({
    version: z.literal(1),
    epochId: boundedId,
    authorityRevision: nonnegativeInteger,
    generationId: boundedId,
    manifestDigest: boundedDigest,
    tasksDigest: boundedDigest,
    qualityDigest: boundedDigest,
    approvalEvidence: recoveryEvidenceRefSchema,
    issuedAt: z.string().min(1).max(128),
  })
  .readonly();
export type TaskExecutionPermit = z.infer<typeof TaskExecutionPermitSchema>;

export function sameGeneration(left: BriefGenerationRef, right: BriefGenerationRef): boolean {
  return (
    left.generationId === right.generationId &&
    left.manifestDigest === right.manifestDigest &&
    left.tasksDigest === right.tasksDigest &&
    left.qualityDigest === right.qualityDigest &&
    left.programId === right.programId
  );
}

export function sameExecutionPermit(
  left: TaskExecutionPermit,
  right: TaskExecutionPermit,
): boolean {
  return (
    left.version === right.version &&
    left.epochId === right.epochId &&
    left.authorityRevision === right.authorityRevision &&
    left.generationId === right.generationId &&
    left.manifestDigest === right.manifestDigest &&
    left.tasksDigest === right.tasksDigest &&
    left.qualityDigest === right.qualityDigest &&
    left.approvalEvidence.revision === right.approvalEvidence.revision &&
    left.approvalEvidence.hash === right.approvalEvidence.hash &&
    left.approvalEvidence.path === right.approvalEvidence.path &&
    left.issuedAt === right.issuedAt
  );
}

export const BriefOwnerExpectedSchema = z
  .strictObject({
    epochId: boundedId,
    stateRevision: ConfigRevisionSchema,
    authorityRevision: nonnegativeInteger,
    fence: boundedId,
    evidenceHead: boundedDigest.nullable(),
  })
  .readonly();
export type BriefOwnerExpected = Readonly<{
  epochId: string;
  stateRevision: ConfigRevision;
  authorityRevision: number;
  fence: string;
  evidenceHead: string | null;
}>;

const ownerEventIdentifier = boundedId.regex(/^\S+$/u);
const ownerEventHash = z.string().regex(/^[a-f0-9]{64}$/iu);
const ownerEventAttemptKind = z.enum(['automatic', 'feedback-revision', 'manual-retry']);
const ownerEventRefFields = {
  briefRevision: nonnegativeInteger,
  briefHash: ownerEventHash,
  reportRevision: nonnegativeInteger.nullable(),
  reportHash: ownerEventHash.nullable(),
} as const;
const ownerEventBase = <T extends string>(type: T) => ({
  type: z.literal(type),
  ts: nonnegativeInteger,
  phase: PhaseSchema,
  version: z.literal(1),
  eventId: ownerEventIdentifier,
  sessionId: ownerEventIdentifier,
  epochId: ownerEventIdentifier,
  recoveryRevision: nonnegativeInteger,
});

const ownerEventRefusalCategory = z.enum([
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

const briefRecoveryRefusedEventSchema = z.strictObject({
  ...ownerEventBase('brief_recovery_refused'),
  ...ownerEventRefFields,
  intentId: ownerEventIdentifier,
  operationId: ownerEventIdentifier.nullable(),
  action: BriefRecoveryActionSchema,
  refusalCategory: ownerEventRefusalCategory,
  refusalCode: ownerEventIdentifier,
  status: BriefContractStatusSchema,
});

const briefRecoveryTransitionEventSchema = z.strictObject({
  ...ownerEventBase('brief_recovery_transition'),
  ...ownerEventRefFields,
  operationId: ownerEventIdentifier.nullable(),
  status: BriefContractStatusSchema,
});

const briefRecoveryAcceptedEventSchema = z.strictObject({
  ...ownerEventBase('brief_recovery_accepted'),
  ...ownerEventRefFields,
  operationId: ownerEventIdentifier,
  intentHash: ownerEventHash,
  attemptKind: ownerEventAttemptKind,
  status: z.literal('accepted'),
  dispatchPossibility: z.literal('none'),
  frozenInputCount: nonnegativeInteger,
  queuedInputCount: nonnegativeInteger,
  automaticAllowanceConsumed: z.boolean(),
});

const briefGenerationPublishedEventSchema = z.strictObject({
  ...ownerEventBase('brief_generation_published'),
  operationId: ownerEventIdentifier,
  generation: BriefGenerationRefSchema,
  provenanceDigest: boundedDigest,
});

const briefExecutionPermitIssuedEventSchema = z
  .strictObject({
    ...ownerEventBase('brief_execution_permit_issued'),
    operationId: ownerEventIdentifier,
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
  });

export const BriefOwnerEventSchema = z.discriminatedUnion('type', [
  briefRecoveryRefusedEventSchema,
  briefRecoveryTransitionEventSchema,
  briefRecoveryAcceptedEventSchema,
  briefGenerationPublishedEventSchema,
  briefExecutionPermitIssuedEventSchema,
]);
export type BriefOwnerEvent = z.infer<typeof BriefOwnerEventSchema>;

export type RecoveryEvidenceInput = Readonly<{
  epochId: string;
  kind: string;
  payload: unknown;
  sessionId?: string | undefined;
  operationId?: string | undefined;
  eventId?: string | undefined;
  refs?: readonly string[] | undefined;
  after?: unknown;
}>;

const readyBriefRecoverySchema = NormalBriefRecoveryV1Schema.safeExtend({
  status: z.literal('ready'),
});

const readyRecoveryStateViewSchema = BriefRecoveryStateViewSchema.extend({
  briefRecovery: readyBriefRecoverySchema,
});

const readyOwnerStatePatchSchema = z
  .strictObject({
    recovery: readyRecoveryStateViewSchema,
    authorityRevision: nonnegativeInteger,
    generation: BriefGenerationRefSchema,
    permit: TaskExecutionPermitSchema,
    disposition: z.literal('ready-for-tasks'),
  })
  .superRefine((value, ctx) => {
    if (value.permit.epochId !== value.recovery.briefRecovery.epochId) {
      ctx.addIssue({
        code: 'custom',
        path: ['permit', 'epochId'],
        message: 'permit epoch must match recovery authority',
      });
    }
    if (value.permit.authorityRevision !== value.authorityRevision) {
      ctx.addIssue({
        code: 'custom',
        path: ['permit', 'authorityRevision'],
        message: 'permit authority revision must match the owner patch',
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
        message: 'permit must identify the owner patch generation',
      });
    }
  })
  .readonly();

const parkedOwnerStatePatchSchema = z
  .strictObject({
    recovery: BriefRecoveryStateViewSchema,
    authorityRevision: nonnegativeInteger,
    generation: BriefGenerationRefSchema.nullable(),
    permit: z.null(),
    disposition: z.literal('parked'),
  })
  .readonly();

const terminalOwnerStatePatchSchema = z
  .strictObject({
    recovery: BriefRecoveryStateViewSchema,
    authorityRevision: nonnegativeInteger,
    generation: BriefGenerationRefSchema.nullable(),
    permit: z.null(),
    disposition: z.literal('terminal'),
  })
  .readonly();

export const BriefOwnerStatePatchSchema = z.discriminatedUnion('disposition', [
  readyOwnerStatePatchSchema,
  parkedOwnerStatePatchSchema,
  terminalOwnerStatePatchSchema,
]);
export type BriefOwnerStatePatch = z.infer<typeof BriefOwnerStatePatchSchema>;

export type BriefOwnerProjectNextInput = Readonly<{
  current: BriefRecoveryStateView;
  evidenceRef: RecoveryEvidenceRef;
  eventId: string;
}>;

export type BriefOwnerCommitInput = Readonly<{
  expected: BriefOwnerExpected;
  operationId: string;
  evidence: RecoveryEvidenceInput;
  event: BriefOwnerEvent;
  projectNext: (input: BriefOwnerProjectNextInput) => BriefOwnerStatePatch;
}>;

const briefOwnerCommittedResultSchema = z
  .strictObject({
    kind: z.literal('committed'),
    stateRevision: ConfigRevisionSchema,
    authorityRevision: nonnegativeInteger,
    recovery: BriefRecoveryStateViewSchema,
    generation: BriefGenerationRefSchema.nullable(),
    permit: TaskExecutionPermitSchema.nullable(),
  })
  .superRefine((value, ctx) => {
    if (value.permit === null) return;
    if (value.generation === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['generation'],
        message: 'an execution permit requires an authoritative generation',
      });
      return;
    }
    if (value.recovery.briefRecovery?.status !== 'ready') {
      ctx.addIssue({
        code: 'custom',
        path: ['recovery', 'briefRecovery', 'status'],
        message: 'an execution permit requires ready recovery authority',
      });
    }
    if (value.permit.authorityRevision !== value.authorityRevision) {
      ctx.addIssue({
        code: 'custom',
        path: ['permit', 'authorityRevision'],
        message: 'permit authority revision must match the committed authority',
      });
    }
    if (value.permit.epochId !== value.recovery.briefRecovery?.epochId) {
      ctx.addIssue({
        code: 'custom',
        path: ['permit', 'epochId'],
        message: 'permit epoch must match the committed recovery',
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
        message: 'permit must identify the committed generation',
      });
    }
  })
  .readonly();

const briefOwnerConflictResultSchema = z
  .strictObject({
    kind: z.literal('conflict'),
    stateRevision: z.null(),
    authorityRevision: z.null(),
    recovery: z.null(),
    generation: z.null(),
    permit: z.null(),
  })
  .readonly();

const briefOwnerDurabilityUncertainResultSchema = z
  .strictObject({
    kind: z.literal('durability-uncertain'),
    stateRevision: ConfigRevisionSchema.nullable(),
    authorityRevision: nonnegativeInteger.nullable(),
    recovery: BriefRecoveryStateViewSchema.nullable(),
    generation: BriefGenerationRefSchema.nullable(),
    permit: TaskExecutionPermitSchema.nullable(),
  })
  .readonly();

export const BriefOwnerCommitResultSchema = z.discriminatedUnion('kind', [
  briefOwnerCommittedResultSchema,
  briefOwnerConflictResultSchema,
  briefOwnerDurabilityUncertainResultSchema,
]);

export type BriefOwnerCommitResult =
  | z.infer<typeof briefOwnerCommittedResultSchema>
  | z.infer<typeof briefOwnerConflictResultSchema>
  | z.infer<typeof briefOwnerDurabilityUncertainResultSchema>;

export type BriefOwnerCommitPort = (input: BriefOwnerCommitInput) => BriefOwnerCommitResult;

export type BriefRecoveryControllerDeps = Readonly<{
  provider: BriefRecoveryProviderPort;
  budget: BriefRecoveryBudgetPort;
  evaluateQuality: (input: unknown) => BriefQualityIssue[];
  commit: BriefOwnerCommitPort;
  readRetryContext?:
    | ((input: {
        sessionId: string;
        recovery: NormalBriefRecoveryV1;
        frozenInputIds: readonly string[];
      }) => {
        prompt: string;
        projectDir: string;
        currentKnownSpend: number;
        maxBudget?: number | undefined;
      })
    | undefined;
  now?: (() => string) | undefined;
  nextId?: (() => string) | undefined;
}>;

export type { ConfigRevision, RecoveryEvidenceRef };
