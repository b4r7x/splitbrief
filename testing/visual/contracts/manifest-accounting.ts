import type { z } from 'zod';
import { cropAccountingKey, frameAccountingKey } from './artifact-identity.js';
import type { ArtifactRecord } from './artifacts.js';
import { validateDerivedArtifactOutcome } from './derived-outcomes.js';
import {
  recordFailureOutcome,
  type AccountingOutcomes,
  type ArtifactExpectations,
  type ExpectedArtifactTarget,
  type RecordedArtifacts,
} from './failure-accounting.js';
import {
  getArtifactTargetKey,
  getFailureArtifactIdentity,
  validateFailureUniqueness,
} from './failure-identity.js';
import type { Failure } from './failures.js';
import type { ArtifactKey } from './identifiers.js';
import { appendMapValue } from './multimap.js';
import { validateRequestResolutions } from './request-accounting.js';
import { captureAccountingKey, hasMatchingProvenance, type CaptureSelection } from './selection.js';

export interface ManifestAccountingData {
  readonly selection: CaptureSelection;
  readonly artifacts: readonly ArtifactRecord[];
  readonly failures: readonly Failure[];
}

export function validateManifestAccounting(options: {
  readonly manifest: ManifestAccountingData;
  readonly context: z.core.$RefinementCtx<unknown>;
}): void {
  const { manifest, context } = options;
  const expectedByTarget = createExpectedArtifactMap(manifest.selection);
  const expectations: ArtifactExpectations = {
    byTarget: expectedByTarget,
    byCapture: groupExpectedArtifactsByCapture(expectedByTarget),
  };
  const artifactsByTarget = new Map<string, ArtifactRecord>();
  const artifacts: RecordedArtifacts = {
    byKey: new Map(manifest.artifacts.map((artifact) => [artifact.identity.key, artifact])),
    byTarget: artifactsByTarget,
  };
  const outcomes: AccountingOutcomes = {
    base: new Map<string, string[]>(),
    derivedFailures: new Set<string>(),
  };

  validateRequestResolutions({
    selection: manifest.selection,
    failures: manifest.failures,
    context,
  });
  validateFailureUniqueness({ failures: manifest.failures, context });
  recordArtifacts({
    artifacts: manifest.artifacts,
    expectations,
    recordedByTarget: artifactsByTarget,
    outcomes,
    context,
  });

  for (const [index, failure] of manifest.failures.entries()) {
    recordFailureOutcome({
      failure: { value: failure, index },
      expectations,
      artifacts,
      outcomes,
      context,
    });
  }

  validateExpectedOutcomes({ expectations: expectedByTarget, outcomes: outcomes.base, context });
  validateDerivedOutcomes({
    artifacts: manifest.artifacts,
    failures: outcomes.derivedFailures,
    context,
  });
}

export function collectDiagnosticArtifactKeys(
  manifest: ManifestAccountingData,
): ReadonlySet<ArtifactKey> {
  const keys = new Set(manifest.artifacts.map((artifact) => artifact.identity.key));
  for (const failure of manifest.failures) {
    const identity = getFailureArtifactIdentity(failure);
    if (identity) keys.add(identity.key);
  }
  return keys;
}

function createExpectedArtifactMap(
  selection: CaptureSelection,
): ReadonlyMap<string, ExpectedArtifactTarget> {
  const expected = new Map<string, ExpectedArtifactTarget>();
  for (const [index, target] of selection.targets.entries()) {
    expected.set(frameAccountingKey(target.provenance), {
      provenance: target.provenance,
      selectionTargetIndex: index,
    });
    for (const elementId of target.elementIds) {
      expected.set(cropAccountingKey({ provenance: target.provenance, elementId }), {
        provenance: target.provenance,
        selectionTargetIndex: index,
      });
    }
  }
  return expected;
}

function groupExpectedArtifactsByCapture(
  expectedArtifacts: ReadonlyMap<string, ExpectedArtifactTarget>,
): ReadonlyMap<string, readonly string[]> {
  const grouped = new Map<string, string[]>();
  for (const [artifactTarget, expected] of expectedArtifacts) {
    const captureTarget = captureAccountingKey(expected.provenance);
    const targets = grouped.get(captureTarget) ?? [];
    targets.push(artifactTarget);
    grouped.set(captureTarget, targets);
  }
  return grouped;
}

function recordArtifacts(options: {
  readonly artifacts: readonly ArtifactRecord[];
  readonly expectations: ArtifactExpectations;
  readonly recordedByTarget: Map<string, ArtifactRecord>;
  readonly outcomes: AccountingOutcomes;
  readonly context: z.core.$RefinementCtx<unknown>;
}): void {
  const { artifacts, expectations, recordedByTarget, outcomes, context } = options;
  for (const [index, artifact] of artifacts.entries()) {
    const targetKey = getArtifactTargetKey(artifact.identity);
    const expected = expectations.byTarget.get(targetKey);
    if (!expected) {
      addUnexpectedArtifactIssue({ index, targetKey, context });
      continue;
    }
    if (
      !hasMatchingProvenance({
        left: expected.provenance,
        right: artifact.identity.provenance,
      })
    ) {
      context.addIssue({
        code: 'custom',
        message: 'artifact provenance does not match its selected capture target',
        path: ['artifacts', index, 'identity', 'provenance'],
      });
    }
    recordedByTarget.set(targetKey, artifact);
    addOutcome({
      outcomes: outcomes.base,
      targetKey,
      outcome: `artifact ${artifact.identity.key}`,
    });
  }
}

function validateExpectedOutcomes(options: {
  readonly expectations: ReadonlyMap<string, ExpectedArtifactTarget>;
  readonly outcomes: ReadonlyMap<string, readonly string[]>;
  readonly context: z.core.$RefinementCtx<unknown>;
}): void {
  for (const [targetKey, expected] of options.expectations) {
    const outcomes = options.outcomes.get(targetKey) ?? [];
    if (outcomes.length === 0) {
      options.context.addIssue({
        code: 'custom',
        message: `selected artifact target has no artifact or failure: ${targetKey}`,
        path: ['selection', 'targets', expected.selectionTargetIndex],
      });
    }
    if (outcomes.length > 1) {
      options.context.addIssue({
        code: 'custom',
        message: `artifact target has contradictory outcomes: ${outcomes.join(', ')}`,
        path: ['selection', 'targets', expected.selectionTargetIndex],
      });
    }
  }
}

function validateDerivedOutcomes(options: {
  readonly artifacts: readonly ArtifactRecord[];
  readonly failures: ReadonlySet<string>;
  readonly context: z.core.$RefinementCtx<unknown>;
}): void {
  for (const [index, artifact] of options.artifacts.entries()) {
    validateDerivedArtifactOutcome({
      artifact,
      artifactIndex: index,
      stage: 'svg',
      failures: options.failures,
      context: options.context,
    });
    validateDerivedArtifactOutcome({
      artifact,
      artifactIndex: index,
      stage: 'png',
      failures: options.failures,
      context: options.context,
    });
  }
}

function addOutcome(options: {
  readonly outcomes: Map<string, string[]>;
  readonly targetKey: string;
  readonly outcome: string;
}): void {
  appendMapValue({ map: options.outcomes, key: options.targetKey, value: options.outcome });
}

function addUnexpectedArtifactIssue(options: {
  readonly index: number;
  readonly targetKey: string;
  readonly context: z.core.$RefinementCtx<unknown>;
}): void {
  options.context.addIssue({
    code: 'custom',
    message: `artifact target is not present in the explicit selection: ${options.targetKey}`,
    path: ['artifacts', options.index],
  });
}
