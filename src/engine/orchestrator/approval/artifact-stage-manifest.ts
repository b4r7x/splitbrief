import { isUtf8 } from 'node:buffer';
import { createHash } from 'node:crypto';
import { constants, type BigIntStats, type Dirent } from 'node:fs';
import { lstat, mkdir, open, readdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, win32 } from 'node:path';
import {
  DeclaredArtifactLeaseSchema,
  PlannerArtifactTransportSchema,
  TaskCompilationAttemptIdSchema,
  TaskCompilationBatchIdSchema,
  TASK_BRIEF_COMPILER_POLICY,
  TaskCompilationProgramIdSchema,
  TaskCompilationSemanticIdSchema,
  type TaskCompilationAttemptId,
} from '../../../core/schemas/task-compilation.js';
import { SECURE_DIR_MODE, SECURE_FILE_MODE } from '../../../lib/fs.js';
import { error } from '../../../utils/error.js';
import { isRecord } from '../../../utils/type-guards.js';
import type {
  DeclaredArtifactProvenance,
  DeclaredArtifactRead,
  DeclaredArtifactReceipt,
} from '../../runners/types.js';

export const DECLARED_ARTIFACT_STAGE_MAX_BYTES = 1024 * 1024;

const ARTIFACT_PARENT_SEGMENTS = ['.splitbrief-runner', 'output'] as const;
const ARTIFACT_SENTINEL = Buffer.from([0xff]);
const DEFAULT_DECLARED_ARTIFACT_BOUND = TASK_BRIEF_COMPILER_POLICY.maxDeclaredArtifactBytes;

type ArtifactFileHandle = Awaited<ReturnType<typeof open>>;
export type ArtifactStageEntryType =
  | 'directory'
  | 'file'
  | 'symlink'
  | 'block-device'
  | 'character-device'
  | 'fifo'
  | 'socket'
  | 'unknown';

type ArtifactStageEntry = Readonly<{
  path: string;
  type: ArtifactStageEntryType;
  dev: bigint;
  ino: bigint;
  nlink: bigint;
  mode: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}>;

type ArtifactStageManifest = Readonly<{
  root: ArtifactStageEntry;
  entries: readonly ArtifactStageEntry[];
}>;

type ArtifactLeaseAncestryEntry = Readonly<{
  path: string;
  entry: ArtifactStageEntry;
}>;

export type ArtifactLeaseProvenance = DeclaredArtifactProvenance;

export type ArtifactLeaseReceipt = DeclaredArtifactReceipt;

export type ArtifactStageRead = DeclaredArtifactRead;

export type ArtifactStageLease = Readonly<{
  artifactPath: string;
  readWithReceiptAfterChild: (
    input: Readonly<{ declaredRedactionValues: readonly string[] }>,
  ) => Promise<ArtifactStageRead>;
  revalidateBeforePromotion: () => Promise<string>;
  getReceipt: () => ArtifactLeaseReceipt | undefined;
  dispose: () => Promise<void>;
}>;

export type PrepareArtifactStageLeaseInput = Readonly<{
  stagedProjectDir: string;
  provenance: unknown;
}>;

type LeasePreparation = Readonly<{
  stagedProjectDir: string;
  artifactPath: string;
  artifactRelativePath: string;
  manifestRoot: string;
  scopeRoot: string;
  maxBytes: number;
  provenance: ArtifactLeaseProvenance;
}>;

type ReviewedArtifact = Readonly<{
  text: string;
  digest: string;
  receipt: ArtifactLeaseReceipt;
}>;

const artifactStageError = {
  invalid: (reason: string) =>
    error(
      'custom-planner-artifact-invalid',
      `Configured custom planner artifact is invalid: ${reason}`,
      { reason },
    ),
  invalidState: () =>
    error(
      'custom-planner-artifact-invalid',
      'Configured custom planner artifact is invalid: artifact review lease is not active.',
    ),
} as const;

/**
 * Creates the only result inode a direct planner may later promote. A declared
 * transport gets a fresh lease directory and a retained descriptor; the
 * descriptor, not a child-controlled pathname, supplies review bytes.
 */
export async function prepareArtifactStageLease(
  input: PrepareArtifactStageLeaseInput,
): Promise<ArtifactStageLease> {
  const preparation = normalizePreparation(input);
  await assertStageRoot(preparation.stagedProjectDir);
  await createFreshMetadataDirectories(preparation);

  let handle: ArtifactFileHandle | undefined;
  try {
    handle = await open(preparation.artifactPath, artifactOpenFlags(), SECURE_FILE_MODE);
    await handle.chmod(SECURE_FILE_MODE);
    await writeAll(handle, ARTIFACT_SENTINEL);
    await handle.sync();

    const leaseIdentity = await readHandleStat(handle);
    assertPreparedArtifact(leaseIdentity, preparation.maxBytes);
    const baseline = await captureArtifactStageManifest(preparation.manifestRoot);
    assertManifestHasLeasedArtifact(
      baseline,
      preparation.artifactRelativePath,
      leaseIdentity,
      preparation.maxBytes,
    );
    const ancestry = await captureArtifactAncestry(
      preparation.stagedProjectDir,
      preparation.artifactPath,
    );

    return createArtifactStageLease({
      ...preparation,
      handle,
      leaseIdentity,
      baseline,
      ancestry,
    });
  } catch (cause) {
    if (handle !== undefined) {
      try {
        await handle.close();
      } catch {
        // Preserve the original preparation failure.
      }
    }
    if (isArtifactStageError(cause)) throw cause;
    throw artifactStageError.invalid('declared artifact lease could not be created safely');
  }
}

function createArtifactStageLease(input: {
  stagedProjectDir: string;
  artifactPath: string;
  artifactRelativePath: string;
  manifestRoot: string;
  maxBytes: number;
  provenance: ArtifactLeaseProvenance;
  handle: ArtifactFileHandle;
  leaseIdentity: BigIntStats;
  baseline: ArtifactStageManifest;
  ancestry: readonly ArtifactLeaseAncestryEntry[];
}): ArtifactStageLease {
  const {
    stagedProjectDir,
    artifactPath,
    artifactRelativePath,
    manifestRoot,
    maxBytes,
    provenance,
    handle,
    leaseIdentity,
    baseline,
    ancestry,
  } = input;
  let disposed = false;
  let reviewed: ReviewedArtifact | undefined;

  const assertActive = (): void => {
    if (disposed) throw artifactStageError.invalidState();
  };

  const validateCurrentStage = async (): Promise<void> => {
    const current = await captureArtifactStageManifest(manifestRoot);
    assertOnlyLeasedArtifactChanged({
      baseline,
      current,
      artifactRelativePath,
      leaseIdentity,
      maxBytes,
    });
    await assertFinalArtifactPathBound({
      stagedProjectDir,
      artifactPath,
      ancestry,
      leaseIdentity,
      maxBytes,
    });
  };

  const readReviewedArtifact = async (
    declaredRedactionValues: readonly string[],
  ): Promise<ArtifactStageRead> => {
    assertActive();
    if (reviewed !== undefined) throw artifactStageError.invalidState();
    await validateCurrentStage();
    const bytes = await readLeasedArtifact(handle, leaseIdentity, maxBytes);
    rejectDeclaredValues(bytes, declaredRedactionValues);
    const text = decodeCanonicalUtf8(bytes);
    const receipt = createArtifactLeaseReceipt({ provenance, leaseIdentity, ancestry, bytes });
    reviewed = { text, digest: digest(bytes), receipt };
    return Object.freeze({ text, receipt });
  };

  return {
    artifactPath,
    readWithReceiptAfterChild: ({ declaredRedactionValues }) =>
      readReviewedArtifact(declaredRedactionValues),
    revalidateBeforePromotion: async () => {
      assertActive();
      if (reviewed === undefined) throw artifactStageError.invalidState();
      await validateCurrentStage();
      const bytes = await readLeasedArtifact(handle, leaseIdentity, maxBytes);
      const text = decodeCanonicalUtf8(bytes);
      if (digest(bytes) !== reviewed.digest || text !== reviewed.text) {
        throw artifactStageError.invalid('declared artifact changed after review');
      }
      const currentReceipt = createArtifactLeaseReceipt({
        provenance,
        leaseIdentity,
        ancestry,
        bytes,
      });
      if (currentReceipt.leaseReceiptDigest !== reviewed.receipt.leaseReceiptDigest) {
        throw artifactStageError.invalid('declared artifact receipt changed after review');
      }
      return reviewed.text;
    },
    getReceipt: () => reviewed?.receipt,
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      reviewed = undefined;
      await handle.close();
    },
  };
}

function normalizePreparation(input: PrepareArtifactStageLeaseInput): LeasePreparation {
  const stagedProjectDir = resolve(input.stagedProjectDir);
  if (!isRecord(input.provenance)) {
    throw artifactStageError.invalid('declared artifact provenance is missing');
  }
  const provenance = parseArtifactProvenance(input.provenance);
  const artifactPath = join(stagedProjectDir, provenance.relativePath);
  const scopeRoot = dirname(artifactPath);
  return {
    stagedProjectDir,
    artifactPath,
    artifactRelativePath: relative(stagedProjectDir, artifactPath),
    manifestRoot: stagedProjectDir,
    scopeRoot,
    maxBytes: provenance.maxBytes,
    provenance,
  };
}

function parseArtifactProvenance(
  source: Readonly<Record<string, unknown>>,
): ArtifactLeaseProvenance {
  const semanticId = TaskCompilationSemanticIdSchema.safeParse(source.semanticId);
  const programId = parseNullableId(source.programId, TaskCompilationProgramIdSchema);
  const batchId = parseNullableId(source.batchId, TaskCompilationBatchIdSchema);
  const attemptId = TaskCompilationAttemptIdSchema.safeParse(source.attemptId);
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

function resolveDeclaredPath(input: {
  lease: { data: { path?: string | undefined; relativePath?: string | undefined } };
  leaseId: string;
  attemptId: TaskCompilationAttemptId;
  declaredPath?: unknown;
}): string {
  const { lease, leaseId, attemptId, declaredPath } = input;
  if (typeof declaredPath !== 'string') {
    throw artifactStageError.invalid('declared artifact transport path is invalid');
  }
  if (
    lease.data.path !== undefined &&
    lease.data.relativePath !== undefined &&
    lease.data.path !== lease.data.relativePath
  ) {
    throw artifactStageError.invalid('declared artifact transport paths disagree');
  }
  const leasePath = lease.data.relativePath ?? lease.data.path;
  if (leasePath !== undefined && declaredPath !== leasePath) {
    throw artifactStageError.invalid('declared artifact transport paths disagree');
  }
  const candidate = declaredPath;
  const segments = validateRelativeArtifactPath(candidate);
  if (
    segments[0] !== ARTIFACT_PARENT_SEGMENTS[0] ||
    segments[1] !== ARTIFACT_PARENT_SEGMENTS[1] ||
    segments.length < 4 ||
    !segments.slice(2, -1).some((segment) => segment === leaseId || segment === attemptId)
  ) {
    throw artifactStageError.invalid('declared artifact path is not invocation-unique');
  }
  return segments.join('/');
}

function validateRelativeArtifactPath(path: string): string[] {
  if (
    path.length === 0 ||
    path.includes('\\') ||
    path.includes('\0') ||
    isAbsolute(path) ||
    win32.isAbsolute(path)
  ) {
    throw artifactStageError.invalid('declared artifact path must be relative');
  }
  const segments = path.split('/');
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    throw artifactStageError.invalid('declared artifact path contains traversal');
  }
  return segments;
}

async function createFreshMetadataDirectories(preparation: LeasePreparation): Promise<void> {
  const relativeParentPath = relative(
    preparation.stagedProjectDir,
    dirname(preparation.artifactPath),
  );
  const segments = validateRelativeArtifactPath(relativeParentPath);
  let current = preparation.stagedProjectDir;
  for (const [index, segment] of segments.entries()) {
    current = join(current, segment);
    const isControlParent = index < ARTIFACT_PARENT_SEGMENTS.length;
    const isLeaseScope = current === preparation.scopeRoot;
    await createDirectory(current, isControlParent || isLeaseScope);
  }
}

async function createDirectory(path: string, exclusive: boolean): Promise<void> {
  try {
    await mkdir(path, { mode: SECURE_DIR_MODE });
  } catch (cause) {
    if (exclusive) {
      throw artifactStageError.invalid(
        'declared artifact parent already exists or could not be created',
      );
    }
    if (!isAlreadyExists(cause)) {
      throw artifactStageError.invalid('declared artifact parent could not be created');
    }
  }
  const stat = await readPathStat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw artifactStageError.invalid('declared artifact parent is not a real directory');
  }
}

async function assertStageRoot(stagedProjectDir: string): Promise<void> {
  const stat = await readPathStat(stagedProjectDir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw artifactStageError.invalid('staged project root is not a real directory');
  }
}

async function captureArtifactStageManifest(scopeRoot: string): Promise<ArtifactStageManifest> {
  const rootPath = resolve(scopeRoot);
  const rootStat = await readPathStat(rootPath);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw artifactStageError.invalid('artifact lease scope is not a real directory');
  }

  const entries: ArtifactStageEntry[] = [];
  await captureDirectoryEntries({ directoryPath: rootPath, relativeSegments: [], entries });
  const root = stageEntry('', rootStat);
  entries.sort((left, right) => left.path.localeCompare(right.path));
  return { root, entries };
}

async function captureDirectoryEntries(input: {
  directoryPath: string;
  relativeSegments: readonly string[];
  entries: ArtifactStageEntry[];
}): Promise<void> {
  const { directoryPath, relativeSegments, entries } = input;
  const before = await readPathStat(directoryPath);
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw artifactStageError.invalid('stage entry changed while enumerating');
  }

  let directoryEntries: Dirent[];
  try {
    directoryEntries = await readdir(directoryPath, { withFileTypes: true, encoding: 'utf8' });
  } catch {
    throw artifactStageError.invalid('stage manifest could not be captured');
  }

  directoryEntries.sort((left, right) => left.name.localeCompare(right.name));
  for (const directoryEntry of directoryEntries) {
    assertSafeEntryName(directoryEntry.name);
    const childPath = join(directoryPath, directoryEntry.name);
    const childStat = await readPathStat(childPath);
    const child = stageEntry([...relativeSegments, directoryEntry.name].join('/'), childStat);
    const observedType = direntEntryType(directoryEntry);
    if (observedType !== 'unknown' && observedType !== child.type) {
      throw artifactStageError.invalid('stage entry changed while enumerating');
    }
    entries.push(child);
    if (child.type === 'directory') {
      await captureDirectoryEntries({
        directoryPath: childPath,
        relativeSegments: [...relativeSegments, directoryEntry.name],
        entries,
      });
    }
    const after = await readPathStat(childPath);
    if (!sameUnchangedEntry(child, stageEntry(child.path, after))) {
      throw artifactStageError.invalid('stage entry changed while enumerating');
    }
  }

  const after = await readPathStat(directoryPath);
  if (!sameDirectoryEntry(stageEntry('', before), stageEntry('', after))) {
    throw artifactStageError.invalid('stage entry changed while enumerating');
  }
}

function assertSafeEntryName(name: string): void {
  if (
    name.length === 0 ||
    name === '.' ||
    name === '..' ||
    name.includes('/') ||
    name.includes('\\') ||
    name.includes('\0')
  ) {
    throw artifactStageError.invalid('stage manifest contains an unsafe entry name');
  }
}

function stageEntry(path: string, stat: BigIntStats): ArtifactStageEntry {
  return {
    path,
    type: statEntryType(stat),
    dev: stat.dev,
    ino: stat.ino,
    nlink: stat.nlink,
    mode: stat.mode,
    size: stat.size,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs,
  };
}

function statEntryType(stat: BigIntStats): ArtifactStageEntryType {
  if (stat.isDirectory()) return 'directory';
  if (stat.isFile()) return 'file';
  if (stat.isSymbolicLink()) return 'symlink';
  if (stat.isBlockDevice()) return 'block-device';
  if (stat.isCharacterDevice()) return 'character-device';
  if (stat.isFIFO()) return 'fifo';
  if (stat.isSocket()) return 'socket';
  return 'unknown';
}

function direntEntryType(entry: Dirent): ArtifactStageEntryType {
  if (entry.isDirectory()) return 'directory';
  if (entry.isFile()) return 'file';
  if (entry.isSymbolicLink()) return 'symlink';
  if (entry.isBlockDevice()) return 'block-device';
  if (entry.isCharacterDevice()) return 'character-device';
  if (entry.isFIFO()) return 'fifo';
  if (entry.isSocket()) return 'socket';
  return 'unknown';
}

function assertManifestHasLeasedArtifact(
  manifest: ArtifactStageManifest,
  artifactRelativePath: string,
  leaseIdentity: BigIntStats,
  maxBytes: number,
): void {
  const artifact = manifest.entries.find((entry) => entry.path === artifactRelativePath);
  if (
    artifact === undefined ||
    artifact.type !== 'file' ||
    artifact.nlink !== 1n ||
    artifact.size > BigInt(maxBytes) ||
    !sameInode(artifact, leaseIdentity)
  ) {
    throw artifactStageError.invalid('declared artifact lease is not bound to the staged result');
  }
}

function assertOnlyLeasedArtifactChanged(input: {
  baseline: ArtifactStageManifest;
  current: ArtifactStageManifest;
  artifactRelativePath: string;
  leaseIdentity: BigIntStats;
  maxBytes: number;
}): void {
  const { baseline, current, artifactRelativePath, leaseIdentity, maxBytes } = input;
  if (!sameDirectoryEntry(baseline.root, current.root)) {
    throw artifactStageError.invalid('artifact lease scope changed');
  }

  const currentByPath = new Map(current.entries.map((entry) => [entry.path, entry]));
  if (baseline.entries.length !== current.entries.length) {
    throw artifactStageError.invalid('artifact lease scope entry set changed');
  }
  for (const expected of baseline.entries) {
    const observed = currentByPath.get(expected.path);
    if (observed === undefined) {
      throw artifactStageError.invalid('artifact lease scope entry set changed');
    }
    if (expected.path === artifactRelativePath) {
      assertLeasedResultEntry(observed, leaseIdentity, maxBytes);
      continue;
    }
    if (!sameUnchangedEntry(expected, observed)) {
      throw artifactStageError.invalid('artifact lease scope changed outside the declared result');
    }
  }
}

async function captureArtifactAncestry(
  stagedProjectDir: string,
  artifactPath: string,
): Promise<readonly ArtifactLeaseAncestryEntry[]> {
  const rootPath = resolve(stagedProjectDir);
  const artifactRelativePath = relative(rootPath, resolve(artifactPath));
  const segments = validateRelativeArtifactPath(artifactRelativePath);
  const ancestry: ArtifactLeaseAncestryEntry[] = [];
  let currentPath = rootPath;
  for (const segment of segments.slice(0, -1)) {
    const currentRelativePath = relative(rootPath, currentPath);
    const stat = await readPathStat(currentPath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw artifactStageError.invalid('declared artifact ancestry is not a real directory');
    }
    ancestry.push({ path: currentRelativePath, entry: stageEntry(currentRelativePath, stat) });
    currentPath = join(currentPath, segment);
  }
  const finalRelativePath = relative(rootPath, currentPath);
  const finalStat = await readPathStat(currentPath);
  if (!finalStat.isDirectory() || finalStat.isSymbolicLink()) {
    throw artifactStageError.invalid('declared artifact ancestry is not a real directory');
  }
  ancestry.push({ path: finalRelativePath, entry: stageEntry(finalRelativePath, finalStat) });
  return ancestry;
}

async function assertFinalArtifactPathBound(input: {
  stagedProjectDir: string;
  artifactPath: string;
  ancestry: readonly ArtifactLeaseAncestryEntry[];
  leaseIdentity: BigIntStats;
  maxBytes: number;
}): Promise<void> {
  const { stagedProjectDir, artifactPath, ancestry, leaseIdentity, maxBytes } = input;
  const rootPath = resolve(stagedProjectDir);
  for (const expected of ancestry) {
    const currentPath = expected.path.length === 0 ? rootPath : join(rootPath, expected.path);
    const observed = await readPathStat(currentPath);
    const currentEntry = stageEntry(expected.path, observed);
    if (!sameDirectoryEntry(expected.entry, currentEntry)) {
      throw artifactStageError.invalid('declared artifact ancestry changed');
    }
  }
  const observed = stageEntry(
    relative(rootPath, resolve(artifactPath)),
    await readPathStat(artifactPath),
  );
  assertLeasedResultEntry(observed, leaseIdentity, maxBytes);
}

function assertLeasedResultEntry(
  entry: ArtifactStageEntry,
  leaseIdentity: BigIntStats,
  maxBytes: number,
): void {
  if (
    entry.type !== 'file' ||
    entry.nlink !== 1n ||
    entry.size > BigInt(maxBytes) ||
    !sameInode(entry, leaseIdentity)
  ) {
    throw artifactStageError.invalid('declared artifact is not the leased bounded regular file');
  }
}

async function readLeasedArtifact(
  handle: ArtifactFileHandle,
  leaseIdentity: BigIntStats,
  maxBytes: number,
): Promise<Buffer> {
  try {
    const before = await readHandleStat(handle);
    assertLeasedHandleStat(before, leaseIdentity, maxBytes);
    const expectedSize = safeByteLength(before.size, maxBytes);
    const bytes = Buffer.allocUnsafe(expectedSize);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
      if (bytesRead <= 0 || bytesRead > bytes.byteLength - offset) {
        throw artifactStageError.invalid('declared artifact changed while reading');
      }
      offset += bytesRead;
    }

    const probe = Buffer.alloc(1);
    const { bytesRead } = await handle.read(probe, 0, probe.byteLength, expectedSize);
    if (bytesRead !== 0)
      throw artifactStageError.invalid('declared artifact changed while reading');

    const after = await readHandleStat(handle);
    assertLeasedHandleStat(after, leaseIdentity, maxBytes);
    if (!sameExactFileState(before, after)) {
      throw artifactStageError.invalid('declared artifact changed while reading');
    }
    return bytes;
  } catch (cause) {
    if (isArtifactStageError(cause)) throw cause;
    throw artifactStageError.invalid('declared artifact could not be read');
  }
}

function safeByteLength(size: bigint, maxBytes: number): number {
  if (size < 0n || size > BigInt(maxBytes) || size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw artifactStageError.invalid('declared artifact exceeds the maximum size');
  }
  return Number(size);
}

function assertPreparedArtifact(stat: BigIntStats, maxBytes: number): void {
  if (!stat.isFile() || stat.nlink !== 1n || stat.size !== BigInt(ARTIFACT_SENTINEL.byteLength)) {
    throw artifactStageError.invalid('declared artifact lease could not be created safely');
  }
  if (maxBytes < ARTIFACT_SENTINEL.byteLength) {
    throw artifactStageError.invalid('declared artifact bound is smaller than the lease sentinel');
  }
}

function assertLeasedHandleStat(
  stat: BigIntStats,
  leaseIdentity: BigIntStats,
  maxBytes: number,
): void {
  if (
    !stat.isFile() ||
    stat.nlink !== 1n ||
    stat.size > BigInt(maxBytes) ||
    !sameInode(stat, leaseIdentity)
  ) {
    throw artifactStageError.invalid('declared artifact is not the leased bounded regular file');
  }
}

function sameInode(left: Pick<ArtifactStageEntry, 'dev' | 'ino'>, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameDirectoryEntry(left: ArtifactStageEntry, right: ArtifactStageEntry): boolean {
  return (
    left.type === 'directory' &&
    right.type === 'directory' &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.nlink === right.nlink &&
    left.mode === right.mode &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function sameUnchangedEntry(left: ArtifactStageEntry, right: ArtifactStageEntry): boolean {
  if (left.type === 'directory' || right.type === 'directory') {
    return sameDirectoryEntry(left, right);
  }
  return (
    left.type === right.type &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.nlink === right.nlink &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function sameExactFileState(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.nlink === right.nlink &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function rejectDeclaredValues(bytes: Buffer, values: readonly string[]): void {
  for (const value of new Set(values)) {
    if (value.length > 0 && bytes.includes(Buffer.from(value, 'utf8'))) {
      throw artifactStageError.invalid('declared environment value is present in the artifact');
    }
  }
}

function decodeCanonicalUtf8(bytes: Buffer): string {
  if (!isUtf8(bytes)) throw artifactStageError.invalid('declared artifact is not valid UTF-8');
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) {
    throw artifactStageError.invalid('declared artifact is not canonical UTF-8');
  }
  return text;
}

function createArtifactLeaseReceipt(input: {
  provenance: ArtifactLeaseProvenance;
  leaseIdentity: BigIntStats;
  ancestry: readonly ArtifactLeaseAncestryEntry[];
  bytes: Buffer;
}): ArtifactLeaseReceipt {
  const { provenance, leaseIdentity, ancestry, bytes } = input;
  const ancestryDigest = digestText(
    ['splitbrief-artifact-ancestry-v1', ...ancestry.map(ancestryFingerprint)].join('\0'),
  );
  const receiptBase = {
    semanticId: provenance.semanticId,
    programId: provenance.programId,
    batchId: provenance.batchId,
    attemptId: provenance.attemptId,
    leaseId: provenance.transport.lease.leaseId,
    relativePath: provenance.relativePath,
    inodeIdentity: inodeIdentity(leaseIdentity),
    ancestryDigest,
    sha256: digest(bytes),
    byteLength: bytes.byteLength,
  } satisfies Omit<ArtifactLeaseReceipt, 'leaseReceiptDigest'>;
  return Object.freeze({
    ...receiptBase,
    leaseReceiptDigest: digestText(
      ['splitbrief-artifact-receipt-v1', JSON.stringify(receiptBase)].join('\0'),
    ),
  });
}

function ancestryFingerprint(input: ArtifactLeaseAncestryEntry): string {
  const { path, entry } = input;
  return [
    path,
    entry.type,
    entry.dev.toString(),
    entry.ino.toString(),
    entry.nlink.toString(),
    entry.mode.toString(),
    entry.mtimeNs.toString(),
    entry.ctimeNs.toString(),
  ].join(':');
}

function inodeIdentity(stat: BigIntStats): string {
  return `${stat.dev.toString()}:${stat.ino.toString()}`;
}

function digest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function digestText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

async function readPathStat(path: string): Promise<BigIntStats> {
  try {
    return await lstat(path, { bigint: true });
  } catch {
    throw artifactStageError.invalid('stage manifest could not be captured');
  }
}

async function readHandleStat(handle: ArtifactFileHandle): Promise<BigIntStats> {
  return handle.stat({ bigint: true });
}

function artifactOpenFlags(): number {
  return (
    constants.O_RDWR |
    constants.O_CREAT |
    constants.O_EXCL |
    (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW)
  );
}

function isAlreadyExists(cause: unknown): boolean {
  return typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === 'EEXIST';
}

function isArtifactStageError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'kind' in err &&
    err.kind === 'custom-planner-artifact-invalid'
  );
}

async function writeAll(handle: ArtifactFileHandle, bytes: Buffer): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset, offset);
    if (bytesWritten <= 0 || bytesWritten > bytes.byteLength - offset) {
      throw artifactStageError.invalid('declared artifact lease could not be created safely');
    }
    offset += bytesWritten;
  }
}
