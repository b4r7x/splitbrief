import type { BigIntStats } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, win32 } from 'node:path';
import type { PlannerArtifactAttemptId } from '../../../../core/schemas/planner-artifact.js';
import { SECURE_DIR_MODE } from '../../../../lib/fs/secure.js';
import { hasErrnoCode } from '../../../../utils/errno.js';
import type { LeasePreparation, ArtifactLeaseAncestryEntry } from './types.js';
import {
  artifactStageError,
  readPathStat,
  stageEntry,
  sameDirectoryEntry,
  assertLeasedResultEntry,
} from './capture.js';

const ARTIFACT_PARENT_SEGMENTS = ['.splitbrief-runner', 'output'] as const;

export function resolveDeclaredPath(input: {
  lease: { data: { path?: string | undefined; relativePath?: string | undefined } };
  leaseId: string;
  attemptId: PlannerArtifactAttemptId;
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

export async function createFreshMetadataDirectories(preparation: LeasePreparation): Promise<void> {
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
    if (!hasErrnoCode(cause, 'EEXIST')) {
      throw artifactStageError.invalid('declared artifact parent could not be created');
    }
  }
  const stat = await readPathStat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw artifactStageError.invalid('declared artifact parent is not a real directory');
  }
}

export async function assertStageRoot(stagedProjectDir: string): Promise<void> {
  const stat = await readPathStat(stagedProjectDir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw artifactStageError.invalid('staged project root is not a real directory');
  }
}

export async function captureArtifactAncestry(
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

export async function assertFinalArtifactPathBound(input: {
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
