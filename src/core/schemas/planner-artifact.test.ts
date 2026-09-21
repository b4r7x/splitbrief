import { describe, expect, it } from 'vitest';
import {
  createPlannerArtifactAttemptId,
  MAX_DECLARED_ARTIFACT_BYTES,
  OwnedPlannerArtifactSchema,
  PlannerArtifactBatchIdSchema,
  PlannerArtifactProgramIdSchema,
  PlannerSessionScopeSchema,
  PlannerArtifactTransportSchema,
} from './planner-artifact.js';

const attemptId = createPlannerArtifactAttemptId();
const programId = PlannerArtifactProgramIdSchema.parse('program-0');
const batchId = PlannerArtifactBatchIdSchema.parse('batch-0');

describe('identity and transport schemas', () => {
  it('mints a fresh attempt id per call', () => {
    expect(createPlannerArtifactAttemptId()).not.toBe(createPlannerArtifactAttemptId());
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

  it('parses text past the declared artifact byte bound', () => {
    expect(MAX_DECLARED_ARTIFACT_BYTES).toBe(1_048_576);
    const text = 'a'.repeat(MAX_DECLARED_ARTIFACT_BYTES + 1);
    const byteLength = Buffer.byteLength(text, 'utf8');
    const parsed = OwnedPlannerArtifactSchema.parse({
      semanticId: 'batch-ordinal-0',
      programId,
      batchId,
      attemptId,
      logicalName: 'tasks.md',
      transport: 'stdout-final',
      text,
      byteLength,
      sha256: 'artifact-digest',
      runtimeReceipt: 'runtime-receipt',
      terminal: { status: 'completed', recordId: 'record-1', protocolDigest: 'protocol-digest' },
      sourceReceipt: { kind: 'stdout-final', resultDigest: 'result-digest' },
    });
    expect(parsed.byteLength).toBe(byteLength);
  });
});
