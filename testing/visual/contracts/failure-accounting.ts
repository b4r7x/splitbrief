import type { z } from 'zod';
import { cropAccountingKey, type ArtifactIdentity } from './artifact-identity.js';
import type { ArtifactRecord } from './artifacts.js';
import { recordDerivedFailure } from './derived-outcomes.js';
import { getArtifactTargetKey } from './failure-identity.js';
import type { Failure, FailureStage } from './failures.js';
import type { ArtifactKey } from './identifiers.js';
import { appendMapValue } from './multimap.js';
import {
  captureAccountingKey,
  hasMatchingProvenance,
  type ArtifactProvenance,
} from './selection.js';

export interface ExpectedArtifactTarget {
  readonly provenance: ArtifactProvenance;
  readonly selectionTargetIndex: number;
}

export interface ArtifactExpectations {
  readonly byTarget: ReadonlyMap<string, ExpectedArtifactTarget>;
  readonly byCapture: ReadonlyMap<string, readonly string[]>;
}

export interface RecordedArtifacts {
  readonly byKey: ReadonlyMap<ArtifactKey, ArtifactRecord>;
  readonly byTarget: ReadonlyMap<string, ArtifactRecord>;
}

export interface AccountingOutcomes {
  readonly base: Map<string, string[]>;
  readonly derivedFailures: Set<string>;
}

interface IndexedFailure {
  readonly value: Failure;
  readonly index: number;
}

export function recordFailureOutcome(options: {
  readonly failure: IndexedFailure;
  readonly expectations: ArtifactExpectations;
  readonly artifacts: RecordedArtifacts;
  readonly outcomes: AccountingOutcomes;
  readonly context: z.core.$RefinementCtx<unknown>;
}): void {
  const { failure, expectations, artifacts, outcomes, context } = options;
  const entry = failure.value;
  switch (entry.stage) {
    case 'selection':
      return;
    case 'fixture':
    case 'checkpoint':
    case 'terminal':
    case 'pty':
      recordCaptureFailure({
        provenance: entry.provenance,
        stage: entry.stage,
        failureIndex: failure.index,
        expectations,
        outcomes: outcomes.base,
        context,
      });
      return;
    case 'locator':
      recordExpectedFailure({
        targetKey: cropAccountingKey({
          provenance: entry.provenance,
          elementId: entry.elementId,
        }),
        provenance: entry.provenance,
        stage: entry.stage,
        failureIndex: failure.index,
        expectedArtifacts: expectations.byTarget,
        outcomes: outcomes.base,
        context,
      });
      return;
    case 'serialization':
    case 'write':
      recordArtifactFailure({
        identity: entry.artifact,
        stage: entry.stage,
        failureIndex: failure.index,
        expectedArtifacts: expectations.byTarget,
        artifactsByKey: artifacts.byKey,
        outcomes: outcomes.base,
        context,
      });
      return;
    case 'svg':
    case 'png':
      recordDerivedFailure({
        identity: entry.artifact,
        artifact: artifacts.byTarget.get(getArtifactTargetKey(entry.artifact)),
        stage: entry.stage,
        failureIndex: failure.index,
        failures: outcomes.derivedFailures,
        context,
      });
      return;
    case 'cleanup':
      recordCleanupFailure({
        failure: { value: entry, index: failure.index },
        expectations,
        artifacts,
        outcomes,
        context,
      });
      return;
    default:
      assertNever(entry);
  }
}

function recordCleanupFailure(options: {
  readonly failure: IndexedFailure & { readonly value: Extract<Failure, { stage: 'cleanup' }> };
  readonly expectations: ArtifactExpectations;
  readonly artifacts: RecordedArtifacts;
  readonly outcomes: AccountingOutcomes;
  readonly context: z.core.$RefinementCtx<unknown>;
}): void {
  const { failure, expectations, artifacts, outcomes, context } = options;
  const target = failure.value.target;
  switch (target.kind) {
    case 'run':
      return;
    case 'capture':
      recordCaptureFailure({
        provenance: target.provenance,
        stage: failure.value.stage,
        failureIndex: failure.index,
        expectations,
        outcomes: outcomes.base,
        context,
      });
      return;
    case 'artifact':
      recordArtifactFailure({
        identity: target.artifact,
        stage: failure.value.stage,
        failureIndex: failure.index,
        expectedArtifacts: expectations.byTarget,
        artifactsByKey: artifacts.byKey,
        outcomes: outcomes.base,
        context,
      });
      return;
    default:
      assertNever(target);
  }
}

function recordCaptureFailure(options: {
  readonly provenance: ArtifactProvenance;
  readonly stage: FailureStage;
  readonly failureIndex: number;
  readonly expectations: ArtifactExpectations;
  readonly outcomes: Map<string, string[]>;
  readonly context: z.core.$RefinementCtx<unknown>;
}): void {
  const { provenance, stage, failureIndex, expectations, outcomes, context } = options;
  const captureKey = captureAccountingKey(provenance);
  const targetKeys = expectations.byCapture.get(captureKey);
  if (!targetKeys || targetKeys.length === 0) {
    addUnexpectedFailureIssue({ targetKey: captureKey, failureIndex, context });
    return;
  }

  const expected = expectations.byTarget.get(targetKeys[0] ?? '');
  if (expected && !hasMatchingProvenance({ left: expected.provenance, right: provenance })) {
    context.addIssue({
      code: 'custom',
      message: 'failure provenance does not match its selected capture target',
      path: ['failures', failureIndex, 'provenance'],
    });
  }
  for (const targetKey of targetKeys) {
    addOutcome({ outcomes, targetKey, outcome: `${stage} failure` });
  }
}

function recordArtifactFailure(options: {
  readonly identity: ArtifactIdentity;
  readonly stage: 'serialization' | 'write' | 'cleanup';
  readonly failureIndex: number;
  readonly expectedArtifacts: ReadonlyMap<string, ExpectedArtifactTarget>;
  readonly artifactsByKey: ReadonlyMap<ArtifactKey, ArtifactRecord>;
  readonly outcomes: Map<string, string[]>;
  readonly context: z.core.$RefinementCtx<unknown>;
}): void {
  const { identity, stage, failureIndex, expectedArtifacts, artifactsByKey, outcomes, context } =
    options;
  recordExpectedFailure({
    targetKey: getArtifactTargetKey(identity),
    provenance: identity.provenance,
    stage,
    failureIndex,
    expectedArtifacts,
    outcomes,
    context,
  });
  if (!artifactsByKey.has(identity.key)) return;

  context.addIssue({
    code: 'custom',
    message: `artifact key cannot be both successful and failed at stage ${stage}`,
    path: ['failures', failureIndex, 'artifact', 'key'],
  });
}

function recordExpectedFailure(options: {
  readonly targetKey: string;
  readonly provenance: ArtifactProvenance;
  readonly stage: FailureStage;
  readonly failureIndex: number;
  readonly expectedArtifacts: ReadonlyMap<string, ExpectedArtifactTarget>;
  readonly outcomes: Map<string, string[]>;
  readonly context: z.core.$RefinementCtx<unknown>;
}): void {
  const { targetKey, provenance, stage, failureIndex, expectedArtifacts, outcomes, context } =
    options;
  const expected = expectedArtifacts.get(targetKey);
  if (!expected) {
    addUnexpectedFailureIssue({ targetKey, failureIndex, context });
    return;
  }
  if (!hasMatchingProvenance({ left: expected.provenance, right: provenance })) {
    context.addIssue({
      code: 'custom',
      message: 'failure provenance does not match its selected artifact target',
      path: ['failures', failureIndex],
    });
  }
  addOutcome({ outcomes, targetKey, outcome: `${stage} failure` });
}

function addOutcome(options: {
  readonly outcomes: Map<string, string[]>;
  readonly targetKey: string;
  readonly outcome: string;
}): void {
  appendMapValue({ map: options.outcomes, key: options.targetKey, value: options.outcome });
}

function addUnexpectedFailureIssue(options: {
  readonly targetKey: string;
  readonly failureIndex: number;
  readonly context: z.core.$RefinementCtx<unknown>;
}): void {
  options.context.addIssue({
    code: 'custom',
    message: `failure target is not present in the explicit selection: ${options.targetKey}`,
    path: ['failures', options.failureIndex],
  });
}

function assertNever(value: never): never {
  throw new Error(`unhandled failure variant: ${JSON.stringify(value)}`);
}
