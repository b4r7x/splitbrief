import { isUtf8 } from 'node:buffer';
import type { BigIntStats } from 'node:fs';
import { sha256Hex } from '../../../../utils/sha256.js';
import { artifactStageError } from './capture.js';
import type {
  ArtifactLeaseProvenance,
  ArtifactLeaseAncestryEntry,
  ArtifactLeaseReceipt,
} from './types.js';

export function rejectDeclaredValues(bytes: Buffer, values: readonly string[]): void {
  for (const value of new Set(values)) {
    if (value.length > 0 && bytes.includes(Buffer.from(value, 'utf8'))) {
      throw artifactStageError.invalid('declared environment value is present in the artifact');
    }
  }
}

export function decodeCanonicalUtf8(bytes: Buffer): string {
  if (!isUtf8(bytes)) throw artifactStageError.invalid('declared artifact is not valid UTF-8');
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) {
    throw artifactStageError.invalid('declared artifact is not canonical UTF-8');
  }
  return text;
}

export function createArtifactLeaseReceipt(input: {
  provenance: ArtifactLeaseProvenance;
  leaseIdentity: BigIntStats;
  ancestry: readonly ArtifactLeaseAncestryEntry[];
  bytes: Buffer;
}): ArtifactLeaseReceipt {
  const { provenance, leaseIdentity, ancestry, bytes } = input;
  const ancestryDigest = sha256Hex(
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
    sha256: sha256Hex(bytes),
    byteLength: bytes.byteLength,
  } satisfies Omit<ArtifactLeaseReceipt, 'leaseReceiptDigest'>;
  return Object.freeze({
    ...receiptBase,
    leaseReceiptDigest: sha256Hex(
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
