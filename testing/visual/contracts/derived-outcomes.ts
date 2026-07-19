import type { z } from 'zod';
import type { ArtifactIdentity } from './artifact-identity.js';
import type { ArtifactRecord } from './artifacts.js';
import type { FailureStageSchema } from './failures.js';
import { hasMatchingProvenance } from './selection.js';

export type DerivedFailureStage = (typeof FailureStageSchema.enum)['svg' | 'png'];

export function recordDerivedFailure(options: {
  readonly identity: ArtifactIdentity;
  readonly artifact: ArtifactRecord | undefined;
  readonly stage: DerivedFailureStage;
  readonly failureIndex: number;
  readonly failures: Set<string>;
  readonly context: z.core.$RefinementCtx<unknown>;
}): void {
  const { identity, artifact, stage, failureIndex, failures, context } = options;
  if (!artifact || !hasMatchingArtifactIdentity({ artifact, identity })) {
    context.addIssue({
      code: 'custom',
      message: `${stage} failure must match a successful diagnostic artifact`,
      path: ['failures', failureIndex, 'artifact'],
    });
    return;
  }
  if (artifact.files[stage] !== null) {
    context.addIssue({
      code: 'custom',
      message: `artifact key cannot have both a ${stage} path and ${stage} failure`,
      path: ['failures', failureIndex, 'artifact', 'key'],
    });
  }

  const failureKey = derivedFailureKey({ stage, artifact });
  if (failures.has(failureKey)) {
    context.addIssue({
      code: 'custom',
      message: `duplicate ${stage} failure for artifact ${artifact.identity.key}`,
      path: ['failures', failureIndex],
    });
  }
  failures.add(failureKey);
}

export function validateDerivedArtifactOutcome(options: {
  readonly artifact: ArtifactRecord;
  readonly artifactIndex: number;
  readonly stage: DerivedFailureStage;
  readonly failures: ReadonlySet<string>;
  readonly context: z.core.$RefinementCtx<unknown>;
}): void {
  const { artifact, artifactIndex, stage, failures, context } = options;
  const hasFailure = failures.has(derivedFailureKey({ stage, artifact }));
  if (artifact.files[stage] !== null || hasFailure) return;

  context.addIssue({
    code: 'custom',
    message: `null ${stage} path requires a matching structured ${stage} failure`,
    path: ['artifacts', artifactIndex, 'files', stage],
  });
}

function hasMatchingArtifactIdentity(options: {
  readonly artifact: ArtifactRecord;
  readonly identity: ArtifactIdentity;
}): boolean {
  const { artifact, identity } = options;
  if (
    artifact.identity.kind !== identity.kind ||
    artifact.identity.key !== identity.key ||
    !hasMatchingProvenance({
      left: artifact.identity.provenance,
      right: identity.provenance,
    })
  ) {
    return false;
  }
  if (artifact.identity.kind === 'frame' && identity.kind === 'frame') return true;
  if (artifact.identity.kind === 'crop' && identity.kind === 'crop') {
    return (
      artifact.identity.elementId === identity.elementId &&
      artifact.identity.parentFrameKey === identity.parentFrameKey
    );
  }
  return false;
}

function derivedFailureKey(options: {
  readonly stage: DerivedFailureStage;
  readonly artifact: ArtifactRecord;
}): string {
  return `${options.stage}:${options.artifact.identity.key}`;
}
