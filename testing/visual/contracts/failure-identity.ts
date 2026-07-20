import type { z } from 'zod';
import {
  cropAccountingKey,
  frameAccountingKey,
  type ArtifactIdentity,
} from './artifact-identity.js';
import type { Failure } from './failures.js';
import type { ArtifactKey } from './identifiers.js';
import { captureAccountingKey } from './selection.js';

export function validateFailureUniqueness(options: {
  readonly failures: readonly Failure[];
  readonly context: z.core.$RefinementCtx<unknown>;
}): void {
  const failureScopes = new Map<string, number>();
  const artifactIdentityByKey = new Map<ArtifactKey, string>();

  for (const [index, failure] of options.failures.entries()) {
    const scope = failureDeduplicationKey(failure);
    const previousIndex = failureScopes.get(scope);
    if (previousIndex !== undefined) {
      options.context.addIssue({
        code: 'custom',
        message: `duplicate failure scope already reported at index ${previousIndex}`,
        path: ['failures', index],
      });
    } else {
      failureScopes.set(scope, index);
    }

    const identity = getFailureArtifactIdentity(failure);
    if (!identity) continue;
    const identitySignature = artifactIdentitySignature(identity);
    const previousIdentity = artifactIdentityByKey.get(identity.key);
    if (previousIdentity !== undefined && previousIdentity !== identitySignature) {
      options.context.addIssue({
        code: 'custom',
        message: 'artifact key is used by contradictory failed artifact identities',
        path: ['failures', index],
      });
    } else {
      artifactIdentityByKey.set(identity.key, identitySignature);
    }
  }
}

export function getFailureArtifactIdentity(failure: Failure): ArtifactIdentity | null {
  switch (failure.stage) {
    case 'selection':
    case 'fixture':
    case 'checkpoint':
    case 'terminal':
    case 'pty':
    case 'locator':
      return null;
    case 'serialization':
    case 'svg':
    case 'png':
    case 'write':
      return failure.artifact;
    case 'cleanup':
      switch (failure.target.kind) {
        case 'run':
        case 'capture':
          return null;
        case 'artifact':
          return failure.target.artifact;
        default:
          return assertNever(failure.target);
      }
    default:
      return assertNever(failure);
  }
}

export function getArtifactTargetKey(identity: ArtifactIdentity): string {
  return identity.kind === 'frame'
    ? frameAccountingKey(identity.provenance)
    : cropAccountingKey({
        provenance: identity.provenance,
        elementId: identity.elementId,
      });
}

function failureDeduplicationKey(failure: Failure): string {
  switch (failure.stage) {
    case 'selection':
      return `selection:${captureAccountingKey(failure.target.provenance)}`;
    case 'fixture':
    case 'checkpoint':
    case 'terminal':
    case 'pty':
      return `${failure.stage}:${captureAccountingKey(failure.provenance)}`;
    case 'locator':
      return `locator:${cropAccountingKey({
        provenance: failure.provenance,
        elementId: failure.elementId,
      })}`;
    case 'serialization':
    case 'svg':
    case 'png':
    case 'write':
      return `${failure.stage}:${getArtifactTargetKey(failure.artifact)}`;
    case 'cleanup':
      switch (failure.target.kind) {
        case 'run':
          return 'cleanup:run';
        case 'capture':
          return `cleanup:${captureAccountingKey(failure.target.provenance)}`;
        case 'artifact':
          return `cleanup:${getArtifactTargetKey(failure.target.artifact)}`;
        default:
          return assertNever(failure.target);
      }
    default:
      return assertNever(failure);
  }
}

function artifactIdentitySignature(identity: ArtifactIdentity): string {
  if (identity.kind === 'frame') return frameAccountingKey(identity.provenance);
  return `${cropAccountingKey({
    provenance: identity.provenance,
    elementId: identity.elementId,
  })}:${identity.parentFrameKey}`;
}

function assertNever(value: never): never {
  throw new Error(`unhandled failure variant: ${JSON.stringify(value)}`);
}
