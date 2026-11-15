import type { BigIntStats } from 'node:fs';
import { open } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { SECURE_FILE_MODE } from '../../../../lib/fs/secure.js';
import { sha256Hex } from '../../../../utils/sha256.js';
import { isRecord } from '../../../../utils/type-guards.js';
import { artifactOpenFlags, writeAll, readHandleStat } from './handles.js';
import {
  rejectDeclaredValues,
  decodeCanonicalUtf8,
  createArtifactLeaseReceipt,
} from './receipt.js';
import type {
  PrepareArtifactStageLeaseInput,
  ArtifactStageLease,
  ArtifactFileHandle,
  ArtifactLeaseProvenance,
  ArtifactLeaseAncestryEntry,
  ReviewedArtifact,
  ArtifactStageRead,
  LeasePreparation,
} from './types.js';
import { parseArtifactProvenance } from './provenance.js';
import {
  captureArtifactStageManifest,
  assertManifestHasLeasedArtifact,
  isArtifactStageError,
  artifactStageError,
  type ArtifactStageManifest,
  assertOnlyLeasedArtifactChanged,
  sameExactFileState,
  sameInode,
} from './capture.js';
import {
  assertStageRoot,
  createFreshMetadataDirectories,
  captureArtifactAncestry,
  assertFinalArtifactPathBound,
} from './paths.js';

const ARTIFACT_SENTINEL = Buffer.from([0xff]);

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
    reviewed = { text, digest: sha256Hex(bytes), receipt };
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
      if (sha256Hex(bytes) !== reviewed.digest || text !== reviewed.text) {
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
