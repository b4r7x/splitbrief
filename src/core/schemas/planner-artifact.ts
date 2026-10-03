import { randomUUID } from 'node:crypto';
import { z } from 'zod';

export const MAX_DECLARED_ARTIFACT_BYTES = 1_024 * 1_024;

const nonnegativeInteger = z.number().int().nonnegative();
const boundedId = z.string().min(1).max(256);
const boundedDigest = z.string().min(1).max(512);
const boundedPath = z.string().min(1).max(4_096);

const semanticId = z.string().min(1).max(256);

export const PlannerArtifactSemanticIdSchema = semanticId.brand<'PlannerArtifactSemanticId'>();
export type PlannerArtifactSemanticId = z.infer<typeof PlannerArtifactSemanticIdSchema>;

export const PlannerArtifactProgramIdSchema = semanticId.brand<'PlannerArtifactProgramId'>();
export type PlannerArtifactProgramId = z.infer<typeof PlannerArtifactProgramIdSchema>;

export const PlannerArtifactBatchIdSchema = semanticId.brand<'PlannerArtifactBatchId'>();
export type PlannerArtifactBatchId = z.infer<typeof PlannerArtifactBatchIdSchema>;

const PlannerArtifactOperationIdSchema = semanticId.brand<'PlannerArtifactOperationId'>();

export const PlannerArtifactAttemptIdSchema = z.uuid().brand<'PlannerArtifactAttemptId'>();
export type PlannerArtifactAttemptId = z.infer<typeof PlannerArtifactAttemptIdSchema>;

export function createPlannerArtifactAttemptId(): PlannerArtifactAttemptId {
  return PlannerArtifactAttemptIdSchema.parse(randomUUID());
}

const leaseSchema = z
  .strictObject({
    leaseId: boundedId,
    attemptId: PlannerArtifactAttemptIdSchema.optional(),
    path: boundedPath.optional(),
    relativePath: boundedPath.optional(),
  })
  .readonly();

export const PlannerArtifactTransportSchema = z
  .discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('stdout-final') }).readonly(),
    z.strictObject({ kind: z.literal('declared-file'), lease: leaseSchema }).readonly(),
  ])
  .readonly();
export type PlannerArtifactTransport = z.infer<typeof PlannerArtifactTransportSchema>;
export const DeclaredArtifactLeaseSchema = leaseSchema;

export const PlannerSessionScopeSchema = z
  .discriminatedUnion('kind', [
    z
      .strictObject({
        kind: z.literal('workflow'),
        workflowSessionId: boundedId.nullable(),
      })
      .readonly(),
    z
      .strictObject({
        kind: z.literal('detached-fresh'),
        operationId: PlannerArtifactOperationIdSchema,
        programId: PlannerArtifactProgramIdSchema,
        batchId: PlannerArtifactBatchIdSchema,
        attemptId: PlannerArtifactAttemptIdSchema,
      })
      .readonly(),
  ])
  .readonly();
export type PlannerSessionScope = z.infer<typeof PlannerSessionScopeSchema>;

const artifactLogicalNameSchema = z.enum(['research.md', 'spec.md', 'plan.md', 'tasks.md']);
const terminalReceiptSchema = z
  .strictObject({
    status: z.literal('completed'),
    recordId: boundedId,
    protocolDigest: boundedDigest,
  })
  .readonly();
const sourceReceiptSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('stdout-final'), resultDigest: boundedDigest }).readonly(),
  z
    .strictObject({
      kind: z.literal('declared-file'),
      leaseId: boundedId,
      inodeIdentity: boundedId,
      leaseReceiptDigest: boundedDigest,
    })
    .readonly(),
]);

export const OwnedPlannerArtifactSchema = z
  .strictObject({
    semanticId: PlannerArtifactSemanticIdSchema,
    programId: PlannerArtifactProgramIdSchema.nullable(),
    batchId: PlannerArtifactBatchIdSchema.nullable(),
    attemptId: PlannerArtifactAttemptIdSchema,
    logicalName: artifactLogicalNameSchema,
    transport: z.enum(['stdout-final', 'declared-file']),
    text: z.string(),
    byteLength: nonnegativeInteger,
    sha256: boundedDigest,
    runtimeReceipt: boundedDigest,
    terminal: terminalReceiptSchema,
    sourceReceipt: sourceReceiptSchema,
  })
  .superRefine((value, ctx) => {
    const actualByteLength = Buffer.byteLength(value.text, 'utf8');
    if (value.byteLength !== actualByteLength) {
      ctx.addIssue({
        code: 'custom',
        path: ['byteLength'],
        message: 'byteLength must equal the UTF-8 byte length of text',
      });
    }
    if (value.batchId !== null && value.programId === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['programId'],
        message: 'a batch artifact must identify its program',
      });
    }
    if (value.transport !== value.sourceReceipt.kind) {
      ctx.addIssue({
        code: 'custom',
        path: ['sourceReceipt'],
        message: 'source receipt must match the declared transport',
      });
    }
  })
  .readonly();
