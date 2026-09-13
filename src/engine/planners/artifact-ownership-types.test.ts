import { describe, expect, it } from 'vitest';
import {
  PlannerArtifactBatchIdSchema,
  PlannerArtifactProgramIdSchema,
  PlannerArtifactSemanticIdSchema,
  createPlannerArtifactAttemptId,
} from '../../core/schemas/planner-artifact.js';
import {
  isOwnedPlannerArtifactFor,
  type OwnedPlannerArtifact,
  type PlannerArtifactRequest,
} from './types.js';

const attemptId = createPlannerArtifactAttemptId();
const programId = PlannerArtifactProgramIdSchema.parse('program-0');
const batchId = PlannerArtifactBatchIdSchema.parse('batch-id-0');
const semanticId = PlannerArtifactSemanticIdSchema.parse('batch-0');

const request: PlannerArtifactRequest = {
  semanticId,
  programId,
  batchId,
  attemptId,
  logicalName: 'tasks.md',
  transport: { kind: 'stdout-final' },
};

const artifact: OwnedPlannerArtifact = {
  semanticId,
  programId,
  batchId,
  attemptId,
  logicalName: 'tasks.md',
  transport: 'stdout-final',
  text: 'current final response',
  byteLength: Buffer.byteLength('current final response', 'utf8'),
  sha256: 'artifact-digest',
  runtimeReceipt: 'runtime-receipt',
  terminal: {
    status: 'completed',
    recordId: 'record-1',
    protocolDigest: 'protocol-digest',
  },
  sourceReceipt: { kind: 'stdout-final', resultDigest: 'result-digest' },
};

describe('planner ownership types', () => {
  it('admits exactly one explicit transport and only completed receipts', () => {
    expect(isOwnedPlannerArtifactFor(request, artifact)).toBe(true);
    expect(
      isOwnedPlannerArtifactFor(request, {
        ...artifact,
        terminal: {
          status: 'failed',
          recordId: 'record-1',
          protocolDigest: 'protocol-digest',
        },
      }),
    ).toBe(false);
    expect(
      isOwnedPlannerArtifactFor(request, {
        ...artifact,
        transport: 'auto',
      }),
    ).toBe(false);
  });

  it('requires the artifact identity to match the current request', () => {
    expect(isOwnedPlannerArtifactFor(request, artifact)).toBe(true);
    expect(
      isOwnedPlannerArtifactFor(request, {
        ...artifact,
        attemptId: createPlannerArtifactAttemptId(),
      }),
    ).toBe(false);
    expect(
      isOwnedPlannerArtifactFor(request, {
        ...artifact,
        batchId: PlannerArtifactBatchIdSchema.parse('batch-id-1'),
      }),
    ).toBe(false);
  });

  it('requires a declared-file lease to carry the same attempt identity', () => {
    const declaredRequest: PlannerArtifactRequest = {
      ...request,
      transport: {
        kind: 'declared-file',
        lease: { leaseId: 'lease-1', attemptId },
      },
    };
    const declaredArtifact: OwnedPlannerArtifact = {
      ...artifact,
      transport: 'declared-file',
      sourceReceipt: {
        kind: 'declared-file',
        leaseId: 'lease-1',
        inodeIdentity: 'inode-1',
        leaseReceiptDigest: 'lease-digest',
      },
    };
    expect(isOwnedPlannerArtifactFor(declaredRequest, declaredArtifact)).toBe(true);
    expect(
      isOwnedPlannerArtifactFor(declaredRequest, {
        ...declaredArtifact,
        sourceReceipt: {
          kind: 'declared-file',
          leaseId: 'other-lease',
          inodeIdentity: 'inode-1',
          leaseReceiptDigest: 'lease-digest',
        },
      }),
    ).toBe(false);
    expect(
      isOwnedPlannerArtifactFor(
        {
          ...declaredRequest,
          transport: { kind: 'declared-file', lease: { leaseId: 'lease-1' } },
        },
        declaredArtifact,
      ),
    ).toBe(false);
  });
});
