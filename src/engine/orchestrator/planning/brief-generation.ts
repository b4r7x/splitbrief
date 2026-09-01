import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { BriefGenerationRef } from '../../../core/schemas/brief-owner.js';
import { BriefGenerationRefSchema } from '../../../core/schemas/brief-owner.js';
import { TASK_BRIEF_COMPILER_POLICY } from '../../../core/schemas/task-compilation.js';
import type { SessionRef } from '../../../core/types/session-ref.js';
import type { BriefQualityReport } from '../../spec/brief-quality.js';
import {
  BRIEF_QUALITY_RULE_VERSION,
  briefQualityReportBytes,
} from '../../spec/brief-quality-file.js';
import { canonicalJSON } from '../../../utils/canonical-json.js';
import { sha256Hex } from '../../../utils/sha256.js';
import type {
  DirectoryExpectation,
  ImmutableInstallOperations,
  VerifiedDirectory,
} from './immutable-store.js';
import {
  briefGenerationStorageError,
  CANDIDATE_PREFIX,
  installImmutableDirectory,
  scanStore,
  storeRoot,
  verifyImmutableDirectory,
} from './immutable-store.js';

export const BRIEF_GENERATION_STORAGE_POLICY = {
  version: 'brief-generation-storage-v1',
  maxGenerationBytes: TASK_BRIEF_COMPILER_POLICY.maxGenerationBytes,
  maxUnreferencedGenerations: 4,
  maxUnreferencedGenerationBytes: 32 * 1_024 * 1_024,
  maxSupportSnapshots: 2,
  maxSupportBytes: 16 * 1_024 * 1_024,
  maxTotalBytes: 48 * 1_024 * 1_024,
} as const;

const GENERATION_ID_DOMAIN = 'splitbrief-brief-generation-v1';
const GENERATION_ID_PREFIX = 'generation-';
const SUPPORT_ID_DOMAIN = 'splitbrief-support-snapshot-v1';
const SUPPORT_ID_PREFIX = 'support-';
const GENERATIONS_DIR = 'generations';
const SUPPORT_SNAPSHOTS_DIR = 'support-snapshots';

const artifactEntrySchema = z
  .strictObject({
    name: z.enum(['research.md', 'spec.md', 'plan.md', 'tasks.md', 'brief-quality.json']),
    sha256: z.string().min(1).max(512),
    byteLength: z.number().int().nonnegative(),
  })
  .readonly();

export const BriefGenerationManifestSchema = z
  .strictObject({
    version: z.literal(1),
    compilerPolicy: z.literal(TASK_BRIEF_COMPILER_POLICY.version),
    qualityPolicy: z.literal(BRIEF_QUALITY_RULE_VERSION),
    programId: z.string().min(1).max(256).nullable(),
    parentGenerationId: z.string().min(1).max(256).nullable(),
    batchReceiptDigests: z.array(z.string().min(1).max(512)),
    artifacts: z.array(artifactEntrySchema),
  })
  .superRefine((value, ctx) => {
    const names = new Set<string>();
    for (const artifact of value.artifacts) {
      if (names.has(artifact.name)) {
        ctx.addIssue({
          code: 'custom',
          path: ['artifacts'],
          message: `duplicate artifact ${artifact.name}`,
        });
        return;
      }
      names.add(artifact.name);
    }
    if (!names.has('tasks.md') || !names.has('brief-quality.json')) {
      ctx.addIssue({
        code: 'custom',
        path: ['artifacts'],
        message: 'a generation manifest requires tasks.md and brief-quality.json',
      });
    }
    if (value.programId === null && value.batchReceiptDigests.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['batchReceiptDigests'],
        message: 'a generation without a program has no batch receipts',
      });
    }
  })
  .readonly();
export type BriefGenerationManifest = z.infer<typeof BriefGenerationManifestSchema>;

const BriefSupportManifestSchema = z
  .strictObject({
    version: z.literal(1),
    programId: z.string().min(1).max(256),
    artifacts: z
      .array(
        z
          .strictObject({
            name: z.enum(['research.md', 'spec.md', 'plan.md']),
            sha256: z.string().min(1).max(512),
            byteLength: z.number().int().nonnegative(),
          })
          .readonly(),
      )
      .length(3),
  })
  .readonly();
export type BriefSupportManifest = z.infer<typeof BriefSupportManifestSchema>;

export type BriefSupportArtifact = Readonly<{
  name: 'research.md' | 'spec.md' | 'plan.md';
  text: string;
}>;

type BriefGenerationArtifact = Readonly<{
  name: z.infer<typeof artifactEntrySchema>['name'];
  text: string;
}>;

export type BriefGenerationCandidate = Readonly<{
  programId: string | null;
  parentGenerationId: string | null;
  batchReceiptDigests: readonly string[];
  tasksText: string;
  qualityReport: BriefQualityReport;
  support: readonly BriefSupportArtifact[];
}>;

export type BriefGenerationIdentity = Readonly<{
  manifestBytes: string;
  manifestDigest: string;
  generationId: string;
  ref: BriefGenerationRef;
  totalBytes: number;
}>;

export type BriefSupportSnapshotInput = Readonly<{
  programId: string;
  research: string;
  spec: string;
  plan: string;
}>;

export type BriefSupportSnapshotIdentity = Readonly<{
  manifestBytes: string;
  manifestDigest: string;
  supportId: string;
  researchDigest: string;
  specDigest: string;
  planDigest: string;
  programId: string;
  totalBytes: number;
}>;

export type StoredGeneration = Readonly<{
  generationId: string;
  ref: BriefGenerationRef;
  totalBytes: number;
  createdAtMs: number;
}>;

export type StoredSupportSnapshot = Readonly<{
  supportId: string;
  totalBytes: number;
  createdAtMs: number;
}>;

const GENERATION_ARTIFACT_ORDER: readonly BriefGenerationArtifact['name'][] = [
  'research.md',
  'spec.md',
  'plan.md',
  'tasks.md',
  'brief-quality.json',
];

export type BriefGenerationInstallInput = Readonly<{
  ref: SessionRef;
  candidate: BriefGenerationCandidate;
}>;

export type BriefGenerationInstallResult = Readonly<{
  kind: 'installed' | 'reused';
  identity: BriefGenerationIdentity;
}>;

export function installBriefGeneration(
  input: BriefGenerationInstallInput,
): BriefGenerationInstallResult {
  return installBriefGenerationWithOperations(input, {});
}

export function installBriefGenerationForTest(
  input: BriefGenerationInstallInput,
  operations: ImmutableInstallOperations,
): BriefGenerationInstallResult {
  return installBriefGenerationWithOperations(input, operations);
}

export type BriefSupportSnapshotStoreInput = Readonly<{
  ref: SessionRef;
  snapshot: BriefSupportSnapshotInput;
}>;

export type BriefSupportSnapshotStoreResult = Readonly<{
  kind: 'installed' | 'reused';
  identity: BriefSupportSnapshotIdentity;
}>;

export function storeBriefSupportSnapshot(
  input: BriefSupportSnapshotStoreInput,
): BriefSupportSnapshotStoreResult {
  return storeBriefSupportSnapshotWithOperations(input, {});
}

export type GenerationStorageObservation = Readonly<{
  generations: readonly StoredGeneration[];
  support: readonly StoredSupportSnapshot[];
  unverifiedGenerationIds: readonly string[];
  unverifiedSupportIds: readonly string[];
  candidateDirs: readonly string[];
  totalBytes: number;
}>;

export function observeGenerationStorage(ref: SessionRef): GenerationStorageObservation {
  const generations = scanStore(ref, GENERATIONS_DIR, verifyGenerationDirectory);
  const support = scanStore(ref, SUPPORT_SNAPSHOTS_DIR, verifySupportDirectory);
  return {
    generations: generations.verified.map((entry) => storedGenerationFrom(entry)),
    support: support.verified.map((entry) => storedSupportFrom(entry)),
    unverifiedGenerationIds: generations.unverified.map((entry) => entry.id),
    unverifiedSupportIds: support.unverified.map((entry) => entry.id),
    candidateDirs: [
      ...generations.candidates.map((entry) => entry.name),
      ...support.candidates.map((entry) => entry.name),
    ],
    totalBytes: generations.totalBytes + support.totalBytes,
  };
}

export function verifyStoredGeneration(ref: SessionRef, generationId: string): StoredGeneration {
  const storeDir = storeRoot(ref, GENERATIONS_DIR);
  const targetDir = join(storeDir, generationId);
  if (!existsSync(targetDir)) {
    throw briefGenerationStorageError.mismatch(`missing generation ${generationId}`);
  }
  return storedGenerationFrom(
    verifyGenerationDirectory(targetDir, { id: generationId, manifestDigest: null }),
  );
}

export function verifyStoredSupportSnapshot(
  ref: SessionRef,
  supportId: string,
): StoredSupportSnapshot {
  const storeDir = storeRoot(ref, SUPPORT_SNAPSHOTS_DIR);
  const targetDir = join(storeDir, supportId);
  if (!existsSync(targetDir)) {
    throw briefGenerationStorageError.mismatch(`missing support snapshot ${supportId}`);
  }
  return storedSupportFrom(
    verifySupportDirectory(targetDir, { id: supportId, manifestDigest: null }),
  );
}

export type GenerationStorageReservation = Readonly<{
  totalBytes: number;
  availableBytes: number;
}>;

export function reserveGenerationStorage(ref: SessionRef): GenerationStorageReservation {
  const observation = observeGenerationStorage(ref);
  if (
    observation.totalBytes + BRIEF_GENERATION_STORAGE_POLICY.maxGenerationBytes >
    BRIEF_GENERATION_STORAGE_POLICY.maxTotalBytes
  ) {
    throw briefGenerationStorageError.quota(
      observation.totalBytes,
      BRIEF_GENERATION_STORAGE_POLICY.maxTotalBytes,
    );
  }
  return {
    totalBytes: observation.totalBytes,
    availableBytes: BRIEF_GENERATION_STORAGE_POLICY.maxTotalBytes - observation.totalBytes,
  };
}

export type CleanupUnreferencedCandidatesInput = Readonly<{
  ref: SessionRef;
  referenced: readonly BriefGenerationRef[];
  currentSupportId?: string | null;
}>;

export type CleanupUnreferencedCandidatesResult = Readonly<{
  evictedGenerationIds: readonly string[];
  evictedSupportIds: readonly string[];
  removedCandidateDirs: readonly string[];
  retainedGenerations: readonly StoredGeneration[];
  retainedSupport: readonly StoredSupportSnapshot[];
  totalBytes: number;
}>;

export function cleanupUnreferencedCandidates(
  input: CleanupUnreferencedCandidatesInput,
): CleanupUnreferencedCandidatesResult {
  const generations = scanStore(input.ref, GENERATIONS_DIR, verifyGenerationDirectory);
  const support = scanStore(input.ref, SUPPORT_SNAPSHOTS_DIR, verifySupportDirectory);

  const removedCandidateDirs: string[] = [];
  for (const entry of [...generations.candidates, ...support.candidates]) {
    const dirPath = entry.name.startsWith(CANDIDATE_PREFIX)
      ? join(storeRoot(input.ref, entry.storeDirName), entry.name)
      : null;
    if (dirPath === null) continue;
    rmSync(dirPath, { recursive: true, force: true });
    removedCandidateDirs.push(entry.name);
  }

  const referencedIds = new Set(input.referenced.map((generation) => generation.generationId));
  const referencedGenerations = generations.verified.filter((entry) => referencedIds.has(entry.id));
  const referencedSupport = support.verified.filter((entry) => entry.id === input.currentSupportId);
  const referencedBytes =
    sumOf(referencedGenerations, (entry) => entry.totalBytes) +
    sumOf(referencedSupport, (entry) => entry.totalBytes) +
    sumOf(generations.unverified, (entry) => entry.totalBytes) +
    sumOf(support.unverified, (entry) => entry.totalBytes);

  const unreferenced: Array<{
    kind: 'generation' | 'support';
    id: string;
    totalBytes: number;
    createdAtMs: number;
    storeDirName: string;
  }> = [];
  for (const entry of generations.verified) {
    if (referencedIds.has(entry.id)) continue;
    unreferenced.push({
      kind: 'generation',
      id: entry.id,
      totalBytes: entry.totalBytes,
      createdAtMs: entry.createdAtMs,
      storeDirName: GENERATIONS_DIR,
    });
  }
  for (const entry of support.verified) {
    if (entry.id === input.currentSupportId) continue;
    unreferenced.push({
      kind: 'support',
      id: entry.id,
      totalBytes: entry.totalBytes,
      createdAtMs: entry.createdAtMs,
      storeDirName: SUPPORT_SNAPSHOTS_DIR,
    });
  }

  const policy = BRIEF_GENERATION_STORAGE_POLICY;
  const generationQueue = unreferenced
    .filter((entry) => entry.kind === 'generation')
    .sort((left, right) =>
      left.createdAtMs === right.createdAtMs
        ? left.id.localeCompare(right.id)
        : left.createdAtMs - right.createdAtMs,
    );
  const supportQueue = unreferenced
    .filter((entry) => entry.kind === 'support')
    .sort((left, right) =>
      left.createdAtMs === right.createdAtMs
        ? left.id.localeCompare(right.id)
        : left.createdAtMs - right.createdAtMs,
    );
  let unreferencedGenerationCount = generationQueue.length;
  let unreferencedSupportCount = supportQueue.length;
  let unreferencedGenerationBytes = generationQueue.reduce(
    (total, entry) => total + entry.totalBytes,
    0,
  );
  let unreferencedSupportBytes = supportQueue.reduce((total, entry) => total + entry.totalBytes, 0);
  let totalBytes = referencedBytes + unreferencedGenerationBytes + unreferencedSupportBytes;

  const evictedGenerationIds: string[] = [];
  const evictedSupportIds: string[] = [];
  let generationIndex = 0;
  let supportIndex = 0;
  while (true) {
    const generationsOver =
      unreferencedGenerationCount > policy.maxUnreferencedGenerations ||
      unreferencedGenerationBytes > policy.maxUnreferencedGenerationBytes;
    const supportOver =
      unreferencedSupportCount > policy.maxSupportSnapshots ||
      unreferencedSupportBytes > policy.maxSupportBytes;
    const totalOver = totalBytes > policy.maxTotalBytes;
    if (!generationsOver && !supportOver && !totalOver) break;

    let next: { kind: 'generation' | 'support'; entry: (typeof generationQueue)[number] } | null =
      null;
    const generationEntry = generationQueue[generationIndex];
    const supportEntry = supportQueue[supportIndex];
    if (generationsOver && generationEntry !== undefined) {
      next = { kind: 'generation', entry: generationEntry };
    } else if (supportOver && supportEntry !== undefined) {
      next = { kind: 'support', entry: supportEntry };
    } else if (totalOver) {
      if (generationEntry === undefined && supportEntry === undefined) break;
      if (generationEntry !== undefined && supportEntry === undefined) {
        next = { kind: 'generation', entry: generationEntry };
      } else if (supportEntry !== undefined && generationEntry === undefined) {
        next = { kind: 'support', entry: supportEntry };
      } else if (generationEntry !== undefined && supportEntry !== undefined) {
        next =
          generationEntry.createdAtMs <= supportEntry.createdAtMs
            ? { kind: 'generation', entry: generationEntry }
            : { kind: 'support', entry: supportEntry };
      }
    } else {
      break;
    }
    if (next === null) break;

    rmSync(join(storeRoot(input.ref, next.entry.storeDirName), next.entry.id), {
      recursive: true,
      force: true,
    });
    totalBytes -= next.entry.totalBytes;
    if (next.kind === 'generation') {
      generationIndex += 1;
      unreferencedGenerationCount -= 1;
      unreferencedGenerationBytes -= next.entry.totalBytes;
      evictedGenerationIds.push(next.entry.id);
    } else {
      supportIndex += 1;
      unreferencedSupportCount -= 1;
      unreferencedSupportBytes -= next.entry.totalBytes;
      evictedSupportIds.push(next.entry.id);
    }
  }

  const retainedGenerations = generations.verified
    .filter((entry) => !evictedGenerationIds.includes(entry.id))
    .map((entry) => storedGenerationFrom(entry));
  const retainedSupport = support.verified
    .filter((entry) => !evictedSupportIds.includes(entry.id))
    .map((entry) => storedSupportFrom(entry));

  return {
    evictedGenerationIds,
    evictedSupportIds,
    removedCandidateDirs,
    retainedGenerations,
    retainedSupport,
    totalBytes,
  };
}

export function buildBriefGenerationIdentity(
  input: BriefGenerationCandidate,
): BriefGenerationIdentity {
  const artifacts = generationArtifacts(input);
  const manifest = BriefGenerationManifestSchema.parse({
    version: 1,
    compilerPolicy: TASK_BRIEF_COMPILER_POLICY.version,
    qualityPolicy: BRIEF_QUALITY_RULE_VERSION,
    programId: input.programId,
    parentGenerationId: input.parentGenerationId,
    batchReceiptDigests: [...input.batchReceiptDigests],
    artifacts: artifacts.map((artifact) => ({
      name: artifact.name,
      sha256: sha256Hex(artifact.text),
      byteLength: Buffer.byteLength(artifact.text, 'utf8'),
    })),
  });
  return identityFromManifest(manifest);
}

export function buildBriefSupportSnapshotIdentity(
  input: BriefSupportSnapshotInput,
): BriefSupportSnapshotIdentity {
  const artifacts = [
    { name: 'research.md' as const, text: input.research },
    { name: 'spec.md' as const, text: input.spec },
    { name: 'plan.md' as const, text: input.plan },
  ];
  const manifest = BriefSupportManifestSchema.parse({
    version: 1,
    programId: input.programId,
    artifacts: artifacts.map((artifact) => ({
      name: artifact.name,
      sha256: sha256Hex(artifact.text),
      byteLength: Buffer.byteLength(artifact.text, 'utf8'),
    })),
  });
  const manifestBytes = canonicalJSON(manifest);
  const manifestDigest = sha256Hex(manifestBytes);
  const research = manifest.artifacts[0];
  const spec = manifest.artifacts[1];
  const plan = manifest.artifacts[2];
  if (research === undefined || spec === undefined || plan === undefined) {
    throw briefGenerationStorageError.invalid('support manifest lost a required artifact');
  }
  return {
    manifestBytes,
    manifestDigest,
    supportId: `${SUPPORT_ID_PREFIX}${sha256Hex(`${SUPPORT_ID_DOMAIN}\u0000${manifestBytes}`)}`,
    researchDigest: research.sha256,
    specDigest: spec.sha256,
    planDigest: plan.sha256,
    programId: input.programId,
    totalBytes:
      manifest.artifacts.reduce((total, artifact) => total + artifact.byteLength, 0) +
      Buffer.byteLength(manifestBytes, 'utf8'),
  };
}

function identityFromManifest(manifest: BriefGenerationManifest): BriefGenerationIdentity {
  const manifestBytes = canonicalJSON(manifest);
  const manifestDigest = sha256Hex(manifestBytes);
  const tasks = manifest.artifacts.find((artifact) => artifact.name === 'tasks.md');
  const quality = manifest.artifacts.find((artifact) => artifact.name === 'brief-quality.json');
  if (tasks === undefined || quality === undefined) {
    throw briefGenerationStorageError.invalid('generation manifest lost a required artifact');
  }
  const ref = BriefGenerationRefSchema.parse({
    generationId: `${GENERATION_ID_PREFIX}${sha256Hex(`${GENERATION_ID_DOMAIN}\u0000${manifestBytes}`)}`,
    manifestDigest,
    tasksDigest: tasks.sha256,
    qualityDigest: quality.sha256,
    programId: manifest.programId,
  });
  const totalBytes =
    manifest.artifacts.reduce((total, artifact) => total + artifact.byteLength, 0) +
    Buffer.byteLength(manifestBytes, 'utf8');
  return {
    manifestBytes,
    manifestDigest,
    generationId: ref.generationId,
    ref,
    totalBytes,
  };
}

function generationArtifacts(input: BriefGenerationCandidate): readonly BriefGenerationArtifact[] {
  const artifacts: BriefGenerationArtifact[] = [];
  for (const name of GENERATION_ARTIFACT_ORDER) {
    if (name === 'tasks.md') {
      artifacts.push({ name, text: input.tasksText });
    } else if (name === 'brief-quality.json') {
      artifacts.push({
        name,
        text: briefQualityReportBytes({ issues: input.qualityReport.issues }),
      });
    } else {
      const support = input.support.find((artifact) => artifact.name === name);
      if (support !== undefined) artifacts.push({ name, text: support.text });
    }
  }
  return artifacts;
}

function installBriefGenerationWithOperations(
  input: BriefGenerationInstallInput,
  operations: ImmutableInstallOperations,
): BriefGenerationInstallResult {
  const identity = buildBriefGenerationIdentity(input.candidate);
  if (identity.totalBytes > BRIEF_GENERATION_STORAGE_POLICY.maxGenerationBytes) {
    throw briefGenerationStorageError.oversized(
      identity.totalBytes,
      BRIEF_GENERATION_STORAGE_POLICY.maxGenerationBytes,
    );
  }
  const kind = installImmutableDirectory({
    ref: input.ref,
    storeDirName: GENERATIONS_DIR,
    id: identity.generationId,
    manifestBytes: identity.manifestBytes,
    manifestDigest: identity.manifestDigest,
    artifacts: generationArtifacts(input.candidate),
    verify: (dirPath, expectation) => verifyGenerationDirectory(dirPath, expectation),
    operations,
  });
  return { kind, identity };
}

function storeBriefSupportSnapshotWithOperations(
  input: BriefSupportSnapshotStoreInput,
  operations: ImmutableInstallOperations,
): BriefSupportSnapshotStoreResult {
  const identity = buildBriefSupportSnapshotIdentity(input.snapshot);
  if (identity.totalBytes > BRIEF_GENERATION_STORAGE_POLICY.maxGenerationBytes) {
    throw briefGenerationStorageError.oversized(
      identity.totalBytes,
      BRIEF_GENERATION_STORAGE_POLICY.maxGenerationBytes,
    );
  }
  const supportArtifacts: readonly BriefGenerationArtifact[] = [
    { name: 'research.md', text: input.snapshot.research },
    { name: 'spec.md', text: input.snapshot.spec },
    { name: 'plan.md', text: input.snapshot.plan },
  ];
  const kind = installImmutableDirectory({
    ref: input.ref,
    storeDirName: SUPPORT_SNAPSHOTS_DIR,
    id: identity.supportId,
    manifestBytes: identity.manifestBytes,
    manifestDigest: identity.manifestDigest,
    artifacts: supportArtifacts,
    verify: (dirPath, expectation) => verifySupportDirectory(dirPath, expectation),
    operations,
  });
  return { kind, identity };
}

function verifyGenerationDirectory(
  dirPath: string,
  expectation: DirectoryExpectation,
): VerifiedDirectory<BriefGenerationManifest> {
  return verifyImmutableDirectory({
    dirPath,
    expectation,
    idPrefix: GENERATION_ID_PREFIX,
    idDomain: GENERATION_ID_DOMAIN,
    manifestSchema: BriefGenerationManifestSchema,
  });
}

function verifySupportDirectory(
  dirPath: string,
  expectation: DirectoryExpectation,
): VerifiedDirectory<BriefSupportManifest> {
  return verifyImmutableDirectory({
    dirPath,
    expectation,
    idPrefix: SUPPORT_ID_PREFIX,
    idDomain: SUPPORT_ID_DOMAIN,
    manifestSchema: BriefSupportManifestSchema,
  });
}

function storedGenerationFrom(
  verified: VerifiedDirectory<BriefGenerationManifest>,
): StoredGeneration {
  const tasks = verified.manifest.artifacts.find((artifact) => artifact.name === 'tasks.md');
  const quality = verified.manifest.artifacts.find(
    (artifact) => artifact.name === 'brief-quality.json',
  );
  if (tasks === undefined || quality === undefined) {
    throw briefGenerationStorageError.invalid('verified generation lost a required artifact');
  }
  return {
    generationId: verified.id,
    ref: BriefGenerationRefSchema.parse({
      generationId: verified.id,
      manifestDigest: verified.manifestDigest,
      tasksDigest: tasks.sha256,
      qualityDigest: quality.sha256,
      programId: verified.manifest.programId,
    }),
    totalBytes: verified.totalBytes,
    createdAtMs: verified.createdAtMs,
  };
}

function storedSupportFrom(
  verified: VerifiedDirectory<BriefSupportManifest>,
): StoredSupportSnapshot {
  return {
    supportId: verified.id,
    totalBytes: verified.totalBytes,
    createdAtMs: verified.createdAtMs,
  };
}

function sumOf<T>(entries: readonly T[], pick: (entry: T) => number): number {
  return entries.reduce((total, entry) => total + pick(entry), 0);
}
