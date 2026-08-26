import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { canonicalJSON } from '../../utils/canonical-json.js';
import { sha256Hex } from '../../utils/sha256.js';

export const TASK_BRIEF_COMPILER_POLICY = {
  version: 'task-brief-compiler-v1',
  maxManifestItems: 256,
  maxBatchItems: 4,
  maxDispatches: 64,
  maxPromptBytes: 110_000,
  requestedOutputTokens: 8_192,
  maxNormalizedOutputBytes: 96 * 1_024,
  maxDeclaredArtifactBytes: 96 * 1_024,
  maxRawProtocolBytes: 8 * 1_024 * 1_024,
  maxStderrBytes: 64 * 1_024,
  deadlineMs: 10 * 60_000,
  idleTimeoutMs: 2 * 60_000,
  maxDiagnosticPreviewBytes: 4_096,
  maxOperationEvidenceBytes: 512 * 1_024,
  maxMergedTasksBytes: 64 * 96 * 1_024,
  maxGenerationBytes: 8 * 1_024 * 1_024,
} as const;

const nonnegativeInteger = z.number().int().nonnegative();
const positiveInteger = z.number().int().positive();
const boundedId = z.string().min(1).max(256);
const boundedDigest = z.string().min(1).max(512);
const boundedPath = z.string().min(1).max(4_096);

export const TaskCompilationPolicySchema = z
  .strictObject({
    version: z.literal(TASK_BRIEF_COMPILER_POLICY.version),
    maxManifestItems: z.literal(TASK_BRIEF_COMPILER_POLICY.maxManifestItems),
    maxBatchItems: z.literal(TASK_BRIEF_COMPILER_POLICY.maxBatchItems),
    maxDispatches: z.literal(TASK_BRIEF_COMPILER_POLICY.maxDispatches),
    maxPromptBytes: z.literal(TASK_BRIEF_COMPILER_POLICY.maxPromptBytes),
    requestedOutputTokens: z.literal(TASK_BRIEF_COMPILER_POLICY.requestedOutputTokens),
    maxNormalizedOutputBytes: z.literal(TASK_BRIEF_COMPILER_POLICY.maxNormalizedOutputBytes),
    maxDeclaredArtifactBytes: z.literal(TASK_BRIEF_COMPILER_POLICY.maxDeclaredArtifactBytes),
    maxRawProtocolBytes: z.literal(TASK_BRIEF_COMPILER_POLICY.maxRawProtocolBytes),
    maxStderrBytes: z.literal(TASK_BRIEF_COMPILER_POLICY.maxStderrBytes),
    deadlineMs: z.literal(TASK_BRIEF_COMPILER_POLICY.deadlineMs),
    idleTimeoutMs: z.literal(TASK_BRIEF_COMPILER_POLICY.idleTimeoutMs),
    maxDiagnosticPreviewBytes: z.literal(TASK_BRIEF_COMPILER_POLICY.maxDiagnosticPreviewBytes),
    maxOperationEvidenceBytes: z.literal(TASK_BRIEF_COMPILER_POLICY.maxOperationEvidenceBytes),
    maxMergedTasksBytes: z.literal(TASK_BRIEF_COMPILER_POLICY.maxMergedTasksBytes),
    maxGenerationBytes: z.literal(TASK_BRIEF_COMPILER_POLICY.maxGenerationBytes),
  })
  .readonly();
export type TaskCompilationPolicy = z.infer<typeof TaskCompilationPolicySchema>;

const semanticId = z.string().min(1).max(256);

export const TaskCompilationSemanticIdSchema = semanticId.brand<'TaskCompilationSemanticId'>();
export type TaskCompilationSemanticId = z.infer<typeof TaskCompilationSemanticIdSchema>;

export const TaskCompilationProgramIdSchema = semanticId.brand<'TaskCompilationProgramId'>();
export type TaskCompilationProgramId = z.infer<typeof TaskCompilationProgramIdSchema>;

export const TaskCompilationBatchIdSchema = semanticId.brand<'TaskCompilationBatchId'>();
export type TaskCompilationBatchId = z.infer<typeof TaskCompilationBatchIdSchema>;

export const TaskCompilationOperationIdSchema = semanticId.brand<'TaskCompilationOperationId'>();
export type TaskCompilationOperationId = z.infer<typeof TaskCompilationOperationIdSchema>;

export const TaskCompilationAttemptIdSchema = z.uuid().brand<'TaskCompilationAttemptId'>();
export type TaskCompilationAttemptId = z.infer<typeof TaskCompilationAttemptIdSchema>;

export function createTaskCompilationAttemptId(): TaskCompilationAttemptId {
  return TaskCompilationAttemptIdSchema.parse(randomUUID());
}

export function createTaskCompilationProgramId(input: unknown): TaskCompilationProgramId {
  return TaskCompilationProgramIdSchema.parse(
    `program-${sha256Hex(`task-brief-program\u0000${canonicalJSON(input)}`)}`,
  );
}

export function createTaskCompilationBatchId(
  programId: TaskCompilationProgramId,
  ordinal: number,
  manifestOrdinals: readonly number[],
): TaskCompilationBatchId {
  return TaskCompilationBatchIdSchema.parse(
    `batch-${sha256Hex(
      `task-brief-batch\u0000${canonicalJSON({ programId, ordinal, manifestOrdinals })}`,
    )}`,
  );
}

export const TASK_COMPILATION_FAILURE_CODES = [
  'task_compiler_manifest_invalid',
  'task_compiler_manifest_empty',
  'task_compiler_capacity_exceeded',
  'task_compiler_prompt_too_large',
  'task_compiler_capability_unsupported',
  'task_compiler_dispatch_limit',
  'task_compiler_continuation_forbidden',
  'task_compiler_provider_failed',
  'task_compiler_provider_refused',
  'task_compiler_timeout',
  'task_compiler_cancelled',
  'task_compiler_output_limited',
  'task_compiler_protocol_invalid',
  'task_compiler_final_response_missing',
  'task_compiler_artifact_invalid',
  'task_compiler_invalid_markdown',
  'task_compiler_manifest_mismatch',
  'task_compiler_duplicate_id',
  'task_compiler_duplicate_operation',
  'task_compiler_unknown_dependency',
  'task_compiler_forward_dependency',
  'task_compiler_cycle',
  'task_compiler_quality_blocked',
  'task_compiler_storage_blocked',
] as const;

export const TaskCompilationFailureCodeSchema = z.enum(TASK_COMPILATION_FAILURE_CODES);
export type TaskCompilationFailureCode = z.infer<typeof TaskCompilationFailureCodeSchema>;

const TASK_COMPILATION_FAILURE_STATUSES = [
  'failed',
  'refused',
  'unsupported_tool',
  'incomplete',
  'cancelled',
  'aborted',
  'timeout',
  'truncated',
  'protocol-invalid',
  'unknown',
] as const;

const TASK_COMPILATION_TERMINAL_STATUSES = [
  'completed',
  ...TASK_COMPILATION_FAILURE_STATUSES,
] as const;

export const TaskCompilationTerminalStatusSchema = z.enum(TASK_COMPILATION_TERMINAL_STATUSES);

export const TaskCompilationFailureStatusSchema = z.enum(TASK_COMPILATION_FAILURE_STATUSES);
export type TaskCompilationFailureStatus = z.infer<typeof TaskCompilationFailureStatusSchema>;

const leaseSchema = z
  .strictObject({
    leaseId: boundedId,
    attemptId: TaskCompilationAttemptIdSchema.optional(),
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
export type DeclaredArtifactLease = z.infer<typeof DeclaredArtifactLeaseSchema>;

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
        operationId: TaskCompilationOperationIdSchema,
        programId: TaskCompilationProgramIdSchema,
        batchId: TaskCompilationBatchIdSchema,
        attemptId: TaskCompilationAttemptIdSchema,
      })
      .readonly(),
  ])
  .readonly();
export type PlannerSessionScope = z.infer<typeof PlannerSessionScopeSchema>;

const callEnvelopeShape = {
  version: z.literal(1),
  promptBytes: nonnegativeInteger,
  inputTokensUpperBound: nonnegativeInteger,
  requestedOutputTokens: positiveInteger,
  outputTokensUpperBound: positiveInteger,
  maxNormalizedOutputBytes: positiveInteger,
  maxDeclaredArtifactBytes: positiveInteger,
  maxRawProtocolBytes: positiveInteger,
  maxStderrBytes: positiveInteger,
  deadlineMs: positiveInteger,
  idleTimeoutMs: positiveInteger,
} as const;

function addLimitIssue(ctx: z.RefinementCtx, path: string, value: number, limit: number): void {
  if (value <= limit) return;
  ctx.addIssue({
    code: 'too_big',
    maximum: limit,
    origin: 'number',
    inclusive: true,
    path: [path],
    message: `${path} exceeds compiler policy`,
  });
}

export const CallEnvelopeSchema = z
  .strictObject(callEnvelopeShape)
  .superRefine((value, ctx) => {
    addLimitIssue(ctx, 'promptBytes', value.promptBytes, TASK_BRIEF_COMPILER_POLICY.maxPromptBytes);
    addLimitIssue(
      ctx,
      'inputTokensUpperBound',
      value.inputTokensUpperBound,
      TASK_BRIEF_COMPILER_POLICY.maxPromptBytes,
    );
    addLimitIssue(
      ctx,
      'requestedOutputTokens',
      value.requestedOutputTokens,
      TASK_BRIEF_COMPILER_POLICY.requestedOutputTokens,
    );
    addLimitIssue(
      ctx,
      'outputTokensUpperBound',
      value.outputTokensUpperBound,
      TASK_BRIEF_COMPILER_POLICY.maxNormalizedOutputBytes,
    );
    addLimitIssue(
      ctx,
      'maxNormalizedOutputBytes',
      value.maxNormalizedOutputBytes,
      TASK_BRIEF_COMPILER_POLICY.maxNormalizedOutputBytes,
    );
    addLimitIssue(
      ctx,
      'maxDeclaredArtifactBytes',
      value.maxDeclaredArtifactBytes,
      TASK_BRIEF_COMPILER_POLICY.maxDeclaredArtifactBytes,
    );
    addLimitIssue(
      ctx,
      'maxRawProtocolBytes',
      value.maxRawProtocolBytes,
      TASK_BRIEF_COMPILER_POLICY.maxRawProtocolBytes,
    );
    addLimitIssue(
      ctx,
      'maxStderrBytes',
      value.maxStderrBytes,
      TASK_BRIEF_COMPILER_POLICY.maxStderrBytes,
    );
    addLimitIssue(ctx, 'deadlineMs', value.deadlineMs, TASK_BRIEF_COMPILER_POLICY.deadlineMs);
    addLimitIssue(
      ctx,
      'idleTimeoutMs',
      value.idleTimeoutMs,
      TASK_BRIEF_COMPILER_POLICY.idleTimeoutMs,
    );
  })
  .readonly();
export type TaskCompilationCallEnvelope = z.infer<typeof CallEnvelopeSchema>;

const operationEnvelopeShape = {
  version: z.literal(1),
  dispatchLimit: nonnegativeInteger,
  callCount: nonnegativeInteger,
  totalPromptBytes: nonnegativeInteger,
  totalInputTokensUpperBound: nonnegativeInteger,
  totalOutputTokensUpperBound: nonnegativeInteger,
  totalNormalizedOutputBytes: nonnegativeInteger,
  totalDeclaredArtifactBytes: nonnegativeInteger,
  callsDigest: boundedDigest,
} as const;

export const OperationEnvelopeSchema = z
  .strictObject(operationEnvelopeShape)
  .superRefine((value, ctx) => {
    addLimitIssue(
      ctx,
      'dispatchLimit',
      value.dispatchLimit,
      TASK_BRIEF_COMPILER_POLICY.maxDispatches,
    );
    addLimitIssue(ctx, 'callCount', value.callCount, value.dispatchLimit);
    addLimitIssue(
      ctx,
      'totalPromptBytes',
      value.totalPromptBytes,
      TASK_BRIEF_COMPILER_POLICY.maxPromptBytes * TASK_BRIEF_COMPILER_POLICY.maxDispatches,
    );
    addLimitIssue(
      ctx,
      'totalInputTokensUpperBound',
      value.totalInputTokensUpperBound,
      TASK_BRIEF_COMPILER_POLICY.maxPromptBytes * TASK_BRIEF_COMPILER_POLICY.maxDispatches,
    );
    addLimitIssue(
      ctx,
      'totalOutputTokensUpperBound',
      value.totalOutputTokensUpperBound,
      TASK_BRIEF_COMPILER_POLICY.maxNormalizedOutputBytes *
        TASK_BRIEF_COMPILER_POLICY.maxDispatches,
    );
    addLimitIssue(
      ctx,
      'totalNormalizedOutputBytes',
      value.totalNormalizedOutputBytes,
      TASK_BRIEF_COMPILER_POLICY.maxNormalizedOutputBytes *
        TASK_BRIEF_COMPILER_POLICY.maxDispatches,
    );
    addLimitIssue(
      ctx,
      'totalDeclaredArtifactBytes',
      value.totalDeclaredArtifactBytes,
      TASK_BRIEF_COMPILER_POLICY.maxDeclaredArtifactBytes *
        TASK_BRIEF_COMPILER_POLICY.maxDispatches,
    );
  })
  .readonly();
export type TaskCompilationOperationEnvelope = z.infer<typeof OperationEnvelopeSchema>;

export const TaskCompilationFailureSchema = z
  .strictObject({
    code: TaskCompilationFailureCodeSchema,
    message: z.string().min(1).max(TASK_BRIEF_COMPILER_POLICY.maxDiagnosticPreviewBytes),
    diagnosticPreview: z
      .string()
      .max(TASK_BRIEF_COMPILER_POLICY.maxDiagnosticPreviewBytes)
      .optional(),
  })
  .readonly();
export type TaskCompilationFailure = z.infer<typeof TaskCompilationFailureSchema>;

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
    semanticId: TaskCompilationSemanticIdSchema,
    programId: TaskCompilationProgramIdSchema.nullable(),
    batchId: TaskCompilationBatchIdSchema.nullable(),
    attemptId: TaskCompilationAttemptIdSchema,
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
    if (value.byteLength > TASK_BRIEF_COMPILER_POLICY.maxDeclaredArtifactBytes) {
      ctx.addIssue({
        code: 'too_big',
        maximum: TASK_BRIEF_COMPILER_POLICY.maxDeclaredArtifactBytes,
        origin: 'number',
        inclusive: true,
        path: ['byteLength'],
        message: 'artifact exceeds compiler policy',
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
export type OwnedPlannerArtifact = z.infer<typeof OwnedPlannerArtifactSchema>;

const inputDigestSchema = z.strictObject({
  spec: boundedDigest,
  plan: boundedDigest,
  languageContext: boundedDigest,
  repairSubject: boundedDigest.nullable(),
});
const batchSchema = z
  .strictObject({
    batchId: TaskCompilationBatchIdSchema,
    manifestOrdinals: z
      .array(nonnegativeInteger)
      .min(1)
      .max(TASK_BRIEF_COMPILER_POLICY.maxBatchItems),
    prompt: z.string(),
    envelope: CallEnvelopeSchema,
  })
  .superRefine((value, ctx) => {
    const promptBytes = Buffer.byteLength(value.prompt, 'utf8');
    if (value.envelope.promptBytes !== promptBytes) {
      ctx.addIssue({
        code: 'custom',
        path: ['envelope', 'promptBytes'],
        message: 'promptBytes must match the batch prompt',
      });
    }
  })
  .readonly();

export const TaskCompilationProgramSchema = z
  .strictObject({
    policyVersion: z.literal(TASK_BRIEF_COMPILER_POLICY.version),
    programId: TaskCompilationProgramIdSchema,
    manifestDigest: boundedDigest,
    inputDigests: inputDigestSchema,
    batches: z.array(batchSchema).max(TASK_BRIEF_COMPILER_POLICY.maxDispatches),
    operationEnvelope: OperationEnvelopeSchema,
  })
  .superRefine((value, ctx) => {
    if (value.operationEnvelope.callCount !== value.batches.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['operationEnvelope', 'callCount'],
        message: 'callCount must match the materialized batch count',
      });
    }
    if (value.batches.length > value.operationEnvelope.dispatchLimit) {
      ctx.addIssue({
        code: 'custom',
        path: ['batches'],
        message: 'batch count exceeds the operation dispatch limit',
      });
    }
  })
  .readonly();
export type TaskCompilationProgram = z.infer<typeof TaskCompilationProgramSchema>;
