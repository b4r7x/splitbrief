import { describe, expect, it } from 'vitest';
import {
  CallEnvelopeSchema,
  createTaskCompilationAttemptId,
  createTaskCompilationBatchId,
  createTaskCompilationProgramId,
  OwnedPlannerArtifactSchema,
  OperationEnvelopeSchema,
  PlannerSessionScopeSchema,
  TaskCompilationFailureCodeSchema,
  TaskCompilationPolicySchema,
  PlannerArtifactTransportSchema,
  TASK_BRIEF_COMPILER_POLICY,
} from './task-compilation.js';

const attemptId = createTaskCompilationAttemptId();
const programId = createTaskCompilationProgramId({ spec: 'spec', plan: 'plan' });
const batchId = createTaskCompilationBatchId(programId, 0, [0, 1]);

const callEnvelope = {
  version: 1,
  promptBytes: 12,
  inputTokensUpperBound: 12,
  requestedOutputTokens: TASK_BRIEF_COMPILER_POLICY.requestedOutputTokens,
  outputTokensUpperBound: TASK_BRIEF_COMPILER_POLICY.maxNormalizedOutputBytes,
  maxNormalizedOutputBytes: TASK_BRIEF_COMPILER_POLICY.maxNormalizedOutputBytes,
  maxDeclaredArtifactBytes: TASK_BRIEF_COMPILER_POLICY.maxDeclaredArtifactBytes,
  maxRawProtocolBytes: TASK_BRIEF_COMPILER_POLICY.maxRawProtocolBytes,
  maxStderrBytes: TASK_BRIEF_COMPILER_POLICY.maxStderrBytes,
  deadlineMs: TASK_BRIEF_COMPILER_POLICY.deadlineMs,
  idleTimeoutMs: TASK_BRIEF_COMPILER_POLICY.idleTimeoutMs,
} as const;

describe('TaskCompilationPolicySchema', () => {
  it('locks the V1 policy values', () => {
    expect(TaskCompilationPolicySchema.parse(TASK_BRIEF_COMPILER_POLICY)).toEqual(
      TASK_BRIEF_COMPILER_POLICY,
    );
    expect(
      TaskCompilationPolicySchema.safeParse({
        ...TASK_BRIEF_COMPILER_POLICY,
        maxBatchItems: 5,
      }).success,
    ).toBe(false);
  });
});

describe('compiler envelopes', () => {
  it('admits values at each V1 call limit and rejects an enlarged bound', () => {
    expect(CallEnvelopeSchema.safeParse(callEnvelope).success).toBe(true);
    expect(
      CallEnvelopeSchema.safeParse({
        ...callEnvelope,
        maxRawProtocolBytes: TASK_BRIEF_COMPILER_POLICY.maxRawProtocolBytes + 1,
      }).success,
    ).toBe(false);
  });

  it('keeps operation dispatch and aggregate limits bounded', () => {
    const operation = {
      version: 1,
      dispatchLimit: TASK_BRIEF_COMPILER_POLICY.maxDispatches,
      callCount: TASK_BRIEF_COMPILER_POLICY.maxDispatches,
      totalPromptBytes:
        TASK_BRIEF_COMPILER_POLICY.maxPromptBytes * TASK_BRIEF_COMPILER_POLICY.maxDispatches,
      totalInputTokensUpperBound:
        TASK_BRIEF_COMPILER_POLICY.maxPromptBytes * TASK_BRIEF_COMPILER_POLICY.maxDispatches,
      totalOutputTokensUpperBound:
        TASK_BRIEF_COMPILER_POLICY.maxNormalizedOutputBytes *
        TASK_BRIEF_COMPILER_POLICY.maxDispatches,
      totalNormalizedOutputBytes:
        TASK_BRIEF_COMPILER_POLICY.maxNormalizedOutputBytes *
        TASK_BRIEF_COMPILER_POLICY.maxDispatches,
      totalDeclaredArtifactBytes:
        TASK_BRIEF_COMPILER_POLICY.maxDeclaredArtifactBytes *
        TASK_BRIEF_COMPILER_POLICY.maxDispatches,
      callsDigest: 'calls-digest',
    };
    expect(OperationEnvelopeSchema.safeParse(operation).success).toBe(true);
    expect(
      OperationEnvelopeSchema.safeParse({ ...operation, callCount: operation.dispatchLimit + 1 })
        .success,
    ).toBe(false);
  });
});

describe('identity and transport schemas', () => {
  it('keeps semantic IDs deterministic and attempts fresh', () => {
    expect(createTaskCompilationProgramId({ plan: 'same' })).toBe(
      createTaskCompilationProgramId({ plan: 'same' }),
    );
    expect(createTaskCompilationBatchId(programId, 0, [0, 1])).toBe(batchId);
    expect(createTaskCompilationAttemptId()).not.toBe(createTaskCompilationAttemptId());
  });

  it('admits only one explicit transport and detached session shape', () => {
    expect(PlannerArtifactTransportSchema.safeParse({ kind: 'stdout-final' }).success).toBe(true);
    expect(
      PlannerArtifactTransportSchema.safeParse({
        kind: 'declared-file',
        lease: { leaseId: 'lease-1', attemptId },
      }).success,
    ).toBe(true);
    expect(PlannerArtifactTransportSchema.safeParse({ kind: 'auto' }).success).toBe(false);
    expect(
      PlannerSessionScopeSchema.safeParse({
        kind: 'detached-fresh',
        operationId: 'operation-1',
        programId,
        batchId,
        attemptId,
      }).success,
    ).toBe(true);
  });

  it('keeps terminal failure codes closed', () => {
    expect(TaskCompilationFailureCodeSchema.safeParse('task_compiler_timeout').success).toBe(true);
    expect(TaskCompilationFailureCodeSchema.safeParse('provider said nope').success).toBe(false);
  });
});

describe('OwnedPlannerArtifactSchema', () => {
  it('binds text, terminal, transport, and attempt identity', () => {
    const artifact = {
      semanticId: 'batch-ordinal-0',
      programId,
      batchId,
      attemptId,
      logicalName: 'tasks.md',
      transport: 'stdout-final',
      text: 'current final response',
      byteLength: Buffer.byteLength('current final response', 'utf8'),
      sha256: 'artifact-digest',
      runtimeReceipt: 'runtime-receipt',
      terminal: { status: 'completed', recordId: 'record-1', protocolDigest: 'protocol-digest' },
      sourceReceipt: { kind: 'stdout-final', resultDigest: 'result-digest' },
    } as const;
    expect(OwnedPlannerArtifactSchema.safeParse(artifact).success).toBe(true);
    expect(
      OwnedPlannerArtifactSchema.safeParse({ ...artifact, byteLength: artifact.byteLength + 1 })
        .success,
    ).toBe(false);
    expect(
      OwnedPlannerArtifactSchema.safeParse({
        ...artifact,
        sourceReceipt: {
          kind: 'declared-file',
          leaseId: 'lease',
          inodeIdentity: 'inode',
          leaseReceiptDigest: 'digest',
        },
      }).success,
    ).toBe(false);
  });
});
