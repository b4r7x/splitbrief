import { describe, expect, it } from 'vitest';
import {
  createPlannerArtifactAttemptId,
  MAX_DECLARED_ARTIFACT_BYTES,
  PlannerArtifactBatchIdSchema,
  PlannerArtifactProgramIdSchema,
  PlannerSessionScopeSchema,
  PlannerArtifactTransportSchema,
} from './planner-artifact.js';

const attemptId = createPlannerArtifactAttemptId();
const programId = PlannerArtifactProgramIdSchema.parse('program-0');
const batchId = PlannerArtifactBatchIdSchema.parse('batch-0');

describe('identity and transport schemas', () => {
  it('bounds a declared artifact at 1 MiB', () => {
    expect(MAX_DECLARED_ARTIFACT_BYTES).toBe(1_048_576);
  });

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
