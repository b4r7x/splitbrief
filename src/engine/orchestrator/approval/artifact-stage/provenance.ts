import {
  DeclaredArtifactLeaseSchema,
  MAX_DECLARED_ARTIFACT_BYTES,
  PlannerArtifactAttemptIdSchema,
  PlannerArtifactBatchIdSchema,
  PlannerArtifactProgramIdSchema,
  PlannerArtifactSemanticIdSchema,
  PlannerArtifactTransportSchema,
} from '../../../../core/schemas/planner-artifact.js';
import type { ArtifactLeaseProvenance } from './types.js';
import { artifactStageError } from './capture.js';
import { resolveDeclaredPath } from './paths.js';

const DEFAULT_DECLARED_ARTIFACT_BOUND = MAX_DECLARED_ARTIFACT_BYTES;

export function parseArtifactProvenance(
  source: Readonly<Record<string, unknown>>,
): ArtifactLeaseProvenance {
  const semanticId = PlannerArtifactSemanticIdSchema.safeParse(source.semanticId);
  const programId = parseNullableId(source.programId, PlannerArtifactProgramIdSchema);
  const batchId = parseNullableId(source.batchId, PlannerArtifactBatchIdSchema);
  const attemptId = PlannerArtifactAttemptIdSchema.safeParse(source.attemptId);
  const transport = PlannerArtifactTransportSchema.safeParse(source.transport);
  if (
    !semanticId.success ||
    !programId.success ||
    !batchId.success ||
    !attemptId.success ||
    !transport.success ||
    transport.data.kind !== 'declared-file'
  ) {
    throw artifactStageError.invalid('declared artifact provenance identity is invalid');
  }

  const lease = DeclaredArtifactLeaseSchema.safeParse(transport.data.lease);
  if (!lease.success || lease.data.attemptId !== attemptId.data) {
    throw artifactStageError.invalid('declared artifact lease does not match the attempt');
  }
  const leaseId = lease.data.leaseId;
  if (
    leaseId === '.' ||
    leaseId.includes('..') ||
    leaseId.includes('/') ||
    leaseId.includes('\\')
  ) {
    throw artifactStageError.invalid('declared artifact lease id is unsafe');
  }

  const maxBytes = parseArtifactBound(source.maxBytes);
  const relativePath = resolveDeclaredPath({
    lease,
    leaseId,
    attemptId: attemptId.data,
    declaredPath: source.relativePath,
  });
  return {
    semanticId: semanticId.data,
    programId: programId.data,
    batchId: batchId.data,
    attemptId: attemptId.data,
    transport: transport.data,
    maxBytes,
    relativePath,
  };
}

function parseNullableId<T>(
  value: unknown,
  schema: { safeParse: (input: unknown) => { success: true; data: T } | { success: false } },
): { success: true; data: T | null } | { success: false } {
  if (value === null) return { success: true, data: null };
  const parsed = schema.safeParse(value);
  return parsed.success ? { success: true, data: parsed.data } : { success: false };
}

function parseArtifactBound(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > DEFAULT_DECLARED_ARTIFACT_BOUND
  ) {
    throw artifactStageError.invalid('declared artifact bound is invalid');
  }
  return value;
}
