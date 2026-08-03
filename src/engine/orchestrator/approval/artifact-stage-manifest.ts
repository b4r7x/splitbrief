import { isUtf8 } from 'node:buffer';
import { createHash } from 'node:crypto';
import { constants, type BigIntStats, type Dirent } from 'node:fs';
import { lstat, mkdir, open, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { SECURE_DIR_MODE, SECURE_FILE_MODE } from '../../../lib/fs.js';
import { error } from '../../../utils/error.js';

export const DECLARED_ARTIFACT_STAGE_PATH = '.splitbrief-runner/output/result';
export const DECLARED_ARTIFACT_STAGE_MAX_BYTES = 1024 * 1024;

const ARTIFACT_PARENT_SEGMENTS = ['.splitbrief-runner', 'output'] as const;
const ARTIFACT_RESULT_SEGMENT = 'result';
const ARTIFACT_SENTINEL = Buffer.from([0xff]);

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

type ReviewedArtifact = Readonly<{
  text: string;
  digest: string;
}>;

export type ArtifactStageLease = Readonly<{
  readAfterChild: (
    input: Readonly<{ declaredRedactionValues: readonly string[] }>,
  ) => Promise<string>;
  revalidateBeforePromotion: () => Promise<string>;
  dispose: () => Promise<void>;
}>;

export type PrepareArtifactStageLeaseInput = Readonly<{
  stagedProjectDir: string;
}>;

const artifactStageError = {
  invalid: (reason: string) =>
    error(
      'custom-planner-artifact-invalid',
      `Configured custom planner artifact is invalid: ${reason}`,
      {
        reason,
      },
    ),
  invalidState: () =>
    error(
      'custom-planner-artifact-invalid',
      'Configured custom planner artifact is invalid: artifact review lease is not active.',
    ),
} as const;

/**
 * Creates the only result inode a direct planner may later promote. The handle
 * stays open through the child call, so post-child reads never resolve a
 * child-controlled path or ancestor.
 */
export async function prepareArtifactStageLease(
  input: PrepareArtifactStageLeaseInput,
): Promise<ArtifactStageLease> {
  const stagedProjectDir = resolve(input.stagedProjectDir);
  await assertStageRoot(stagedProjectDir);

  const runnerRoot = join(stagedProjectDir, ARTIFACT_PARENT_SEGMENTS[0]);
  const outputRoot = join(runnerRoot, ARTIFACT_PARENT_SEGMENTS[1]);
  const artifactPath = join(outputRoot, ARTIFACT_RESULT_SEGMENT);
  await createExclusiveDirectory(runnerRoot);
  await createExclusiveDirectory(outputRoot);

  let handle: ArtifactFileHandle | undefined;
  try {
    handle = await open(artifactPath, artifactOpenFlags(), SECURE_FILE_MODE);
    await handle.chmod(SECURE_FILE_MODE);
    await writeAll(handle, ARTIFACT_SENTINEL);
    await handle.sync();
    const leaseIdentity = await readHandleStat(handle);
    assertPreparedArtifact(leaseIdentity);

    const baseline = await captureArtifactStageManifest(stagedProjectDir);
    assertManifestHasLeasedArtifact(baseline, leaseIdentity);

    return createArtifactStageLease({
      stagedProjectDir,
      artifactPath,
      handle,
      leaseIdentity,
      baseline,
    });
  } catch (err) {
    if (handle !== undefined) {
      try {
        await handle.close();
      } catch {
        // Preserve the original preparation failure.
      }
    }
    if (isArtifactStageError(err)) throw err;
    throw artifactStageError.invalid('declared artifact could not be prepared');
  }
}

function createArtifactStageLease(input: {
  stagedProjectDir: string;
  artifactPath: string;
  handle: ArtifactFileHandle;
  leaseIdentity: BigIntStats;
  baseline: ArtifactStageManifest;
}): ArtifactStageLease {
  const { stagedProjectDir, artifactPath, handle, leaseIdentity, baseline } = input;
  let disposed = false;
  let reviewed: ReviewedArtifact | undefined;

  const assertActive = (): void => {
    if (disposed) throw artifactStageError.invalidState();
  };

  const validateCurrentStage = async (): Promise<void> => {
    const current = await captureArtifactStageManifest(stagedProjectDir);
    assertOnlyLeasedArtifactChanged({ baseline, current, leaseIdentity });
    await assertFinalArtifactPathBound({
      stagedProjectDir,
      artifactPath,
      baseline,
      leaseIdentity,
    });
  };

  return {
    readAfterChild: async ({ declaredRedactionValues }) => {
      assertActive();
      if (reviewed !== undefined) throw artifactStageError.invalidState();
      await validateCurrentStage();
      const bytes = await readLeasedArtifact(handle, leaseIdentity);
      rejectDeclaredValues(bytes, declaredRedactionValues);
      const text = decodeCanonicalUtf8(bytes);
      reviewed = { text, digest: digest(bytes) };
      return text;
    },
    revalidateBeforePromotion: async () => {
      assertActive();
      if (reviewed === undefined) throw artifactStageError.invalidState();
      await validateCurrentStage();
      const bytes = await readLeasedArtifact(handle, leaseIdentity);
      const text = decodeCanonicalUtf8(bytes);
      if (digest(bytes) !== reviewed.digest || text !== reviewed.text) {
        throw artifactStageError.invalid('declared artifact changed after review');
      }
      return reviewed.text;
    },
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      reviewed = undefined;
      await handle.close();
    },
  };
}

function artifactOpenFlags(): number {
  return (
    constants.O_RDWR |
    constants.O_CREAT |
    constants.O_EXCL |
    (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW)
  );
}

async function assertStageRoot(stagedProjectDir: string): Promise<void> {
  const stat = await readPathStat(stagedProjectDir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw artifactStageError.invalid('staged project root is not a real directory');
  }
}

async function createExclusiveDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { mode: SECURE_DIR_MODE });
  } catch (err) {
    if (isArtifactStageError(err)) throw err;
    throw artifactStageError.invalid(
      'declared artifact parent already exists or could not be created',
    );
  }
  const stat = await readPathStat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw artifactStageError.invalid('declared artifact parent is not a real directory');
  }
}

async function captureArtifactStageManifest(
  stagedProjectDir: string,
): Promise<ArtifactStageManifest> {
  const rootPath = resolve(stagedProjectDir);
  const rootStat = await readPathStat(rootPath);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw artifactStageError.invalid('staged project root is not a real directory');
  }

  const entries: ArtifactStageEntry[] = [];
  await captureDirectoryEntries({
    directoryPath: rootPath,
    relativeSegments: [],
    entries,
  });
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
  leaseIdentity: BigIntStats,
): void {
  const artifact = manifest.entries.find((entry) => entry.path === DECLARED_ARTIFACT_STAGE_PATH);
  if (artifact === undefined || !sameInode(artifact, leaseIdentity)) {
    throw artifactStageError.invalid('declared artifact lease is not bound to the staged result');
  }
}

function assertOnlyLeasedArtifactChanged(input: {
  baseline: ArtifactStageManifest;
  current: ArtifactStageManifest;
  leaseIdentity: BigIntStats;
}): void {
  const { baseline, current, leaseIdentity } = input;
  if (!sameDirectoryEntry(baseline.root, current.root)) {
    throw artifactStageError.invalid('staged project root changed');
  }

  const currentByPath = new Map(current.entries.map((entry) => [entry.path, entry]));
  if (baseline.entries.length !== current.entries.length) {
    throw artifactStageError.invalid('staged project entry set changed');
  }

  for (const expected of baseline.entries) {
    const observed = currentByPath.get(expected.path);
    if (observed === undefined) {
      throw artifactStageError.invalid('staged project entry set changed');
    }
    if (expected.path === DECLARED_ARTIFACT_STAGE_PATH) {
      assertLeasedResultEntry(observed, leaseIdentity);
      continue;
    }
    if (!sameUnchangedEntry(expected, observed)) {
      throw artifactStageError.invalid('staged project changed outside the declared artifact');
    }
  }
}

async function assertFinalArtifactPathBound(input: {
  stagedProjectDir: string;
  artifactPath: string;
  baseline: ArtifactStageManifest;
  leaseIdentity: BigIntStats;
}): Promise<void> {
  const { stagedProjectDir, artifactPath, baseline, leaseIdentity } = input;
  const baselineByPath = new Map(baseline.entries.map((entry) => [entry.path, entry]));
  let currentPath = stagedProjectDir;
  let currentRelativePath = '';

  for (const segment of ARTIFACT_PARENT_SEGMENTS) {
    currentPath = join(currentPath, segment);
    currentRelativePath =
      currentRelativePath.length === 0 ? segment : `${currentRelativePath}/${segment}`;
    const expected = baselineByPath.get(currentRelativePath);
    const observed = stageEntry(currentRelativePath, await readPathStat(currentPath));
    if (
      expected === undefined ||
      observed.type !== 'directory' ||
      !sameDirectoryEntry(expected, observed)
    ) {
      throw artifactStageError.invalid('declared artifact ancestry changed');
    }
  }

  const observed = stageEntry(DECLARED_ARTIFACT_STAGE_PATH, await readPathStat(artifactPath));
  assertLeasedResultEntry(observed, leaseIdentity);
}

function assertLeasedResultEntry(entry: ArtifactStageEntry, leaseIdentity: BigIntStats): void {
  if (
    entry.type !== 'file' ||
    entry.nlink !== 1n ||
    entry.size > BigInt(DECLARED_ARTIFACT_STAGE_MAX_BYTES) ||
    !sameInode(entry, leaseIdentity)
  ) {
    throw artifactStageError.invalid('declared artifact is not the leased bounded regular file');
  }
}

async function readLeasedArtifact(
  handle: ArtifactFileHandle,
  leaseIdentity: BigIntStats,
): Promise<Buffer> {
  try {
    const before = await readHandleStat(handle);
    assertLeasedHandleStat(before, leaseIdentity);
    const expectedSize = Number(before.size);
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
    assertLeasedHandleStat(after, leaseIdentity);
    if (!sameExactFileState(before, after)) {
      throw artifactStageError.invalid('declared artifact changed while reading');
    }
    return bytes;
  } catch (err) {
    if (isArtifactStageError(err)) throw err;
    throw artifactStageError.invalid('declared artifact could not be read');
  }
}

function assertPreparedArtifact(stat: BigIntStats): void {
  if (!stat.isFile() || stat.nlink !== 1n || stat.size !== BigInt(ARTIFACT_SENTINEL.byteLength)) {
    throw artifactStageError.invalid('declared artifact lease could not be created safely');
  }
}

function assertLeasedHandleStat(stat: BigIntStats, leaseIdentity: BigIntStats): void {
  if (
    !stat.isFile() ||
    stat.nlink !== 1n ||
    stat.size > BigInt(DECLARED_ARTIFACT_STAGE_MAX_BYTES) ||
    !sameInode(stat, leaseIdentity)
  ) {
    throw artifactStageError.invalid('declared artifact is not the leased bounded regular file');
  }
}

function sameInode(left: Pick<ArtifactStageEntry, 'dev' | 'ino'>, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameDirectoryEntry(left: ArtifactStageEntry, right: ArtifactStageEntry): boolean {
  // Directory timestamps are the only retained evidence of create-delete churn
  // when a child restores the final entry set before inspection.
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

function digest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
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
