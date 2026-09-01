import type { BigIntStats, Dirent } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { error } from '../../../utils/error.js';

export type ArtifactStageEntryType =
  | 'directory'
  | 'file'
  | 'symlink'
  | 'block-device'
  | 'character-device'
  | 'fifo'
  | 'socket'
  | 'unknown';

export type ArtifactStageEntry = Readonly<{
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

export type ArtifactStageManifest = Readonly<{
  root: ArtifactStageEntry;
  entries: readonly ArtifactStageEntry[];
}>;

export const artifactStageError = {
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

export function isArtifactStageError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'kind' in err &&
    err.kind === 'custom-planner-artifact-invalid'
  );
}

export async function captureArtifactStageManifest(
  scopeRoot: string,
): Promise<ArtifactStageManifest> {
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

export function stageEntry(path: string, stat: BigIntStats): ArtifactStageEntry {
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

export function assertManifestHasLeasedArtifact(
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

export function assertOnlyLeasedArtifactChanged(input: {
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

export function assertLeasedResultEntry(
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

export function sameInode(
  left: Pick<ArtifactStageEntry, 'dev' | 'ino'>,
  right: BigIntStats,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

export function sameDirectoryEntry(left: ArtifactStageEntry, right: ArtifactStageEntry): boolean {
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

export function sameExactFileState(left: BigIntStats, right: BigIntStats): boolean {
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

export async function readPathStat(path: string): Promise<BigIntStats> {
  try {
    return await lstat(path, { bigint: true });
  } catch {
    throw artifactStageError.invalid('stage manifest could not be captured');
  }
}
