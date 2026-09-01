import { constants, closeSync, fsyncSync, openSync, readFileSync, writeSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { sessionDir } from '../../paths.js';
import type { SessionRef } from '../../types/session-ref.js';
import { ensureSecureDir, rejectSymlinkTarget } from '../../../lib/fs.js';
import {
  assertExistingPathConfined,
  assertWritablePathConfined,
} from '../../../lib/path-confinement.js';
import { canonicalJSON } from '../../../utils/canonical-json.js';
import { sha256Hex } from '../../../utils/sha256.js';
import { error } from '../../../utils/error.js';
import { RECOVERY_ROOT, recoveryArtifactPath, recoveryProjectPath } from './paths.js';
import { MAX_RECOVERY_PAYLOAD_BYTES, recoveryReferenceSchema } from './schema.js';
import type { RecoveryEvidenceRef } from './schema.js';

export function ensureRecoveryParent(ref: SessionRef, absolutePath: string): void {
  const projectRelative = relative(ref.projectDir, absolutePath).split(sep).join('/');
  assertWritablePathConfined(projectRelative, ref.projectDir);
  ensureSecureDir(join(ref.projectDir, projectRelative.split('/').slice(0, -1).join('/')));
  assertWritablePathConfined(projectRelative, ref.projectDir);
}

export function writeAllSync(fd: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const written = writeSync(fd, bytes, offset, bytes.byteLength - offset);
    if (written <= 0)
      throw error('recovery-evidence-storage', 'recovery evidence write made no progress');
    offset += written;
  }
}

export function writeCreateExclusive(ref: SessionRef, filePath: string, bytes: Buffer): void {
  if (bytes.byteLength > MAX_RECOVERY_PAYLOAD_BYTES) {
    throw error('recovery-evidence-storage', 'recovery evidence payload exceeds the bounded size');
  }
  ensureRecoveryParent(ref, filePath);
  rejectSymlinkTarget(filePath);
  try {
    const fd = openSync(
      filePath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      writeAllSync(fd, bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch (err: unknown) {
    const code = err && typeof err === 'object' && 'code' in err ? err.code : undefined;
    if (code !== 'EEXIST') throw err;
    rejectSymlinkTarget(filePath);
    const existing = readFileSync(filePath);
    if (!existing.equals(bytes))
      throw error('recovery-evidence-storage', 'recovery evidence artifact hash collision');
  }
}

export function canonicalPayload(payload: unknown): { bytes: Buffer; hash: string } {
  const bytes = Buffer.from(`${canonicalJSON(payload)}\n`, 'utf8');
  return { bytes, hash: sha256Hex(bytes) };
}

export function artifactRef(
  ref: SessionRef,
  filePath: string,
  payloadHash: string,
): RecoveryEvidenceRef {
  const path = recoveryProjectPath(ref, filePath);
  return { revision: 1, hash: payloadHash, path };
}

export function writeRecoveryArtifact(
  ref: SessionRef,
  input: Readonly<{ epochId: string; eventId: string; payload: unknown }>,
): RecoveryEvidenceRef {
  const { bytes, hash } = canonicalPayload(input.payload);
  const filePath = recoveryArtifactPath(ref, input.epochId, input.eventId, hash);
  writeCreateExclusive(ref, filePath, bytes);
  return artifactRef(ref, filePath, hash);
}

export function readRecoveryArtifact(ref: SessionRef, reference: RecoveryEvidenceRef): unknown {
  const validated = recoveryReferenceSchema.safeParse(reference);
  if (!validated.success)
    throw error('recovery-evidence-storage', 'recovery artifact reference is invalid');
  if (!reference.path.startsWith(`${RECOVERY_ROOT}/`)) {
    throw error(
      'recovery-evidence-storage',
      'recovery artifact reference is outside the recovery namespace',
    );
  }
  const filePath = join(sessionDir(ref.projectDir, ref.sessionId), reference.path);
  const projectRelative = relative(ref.projectDir, filePath).split(sep).join('/');
  assertExistingPathConfined(projectRelative, ref.projectDir);
  rejectSymlinkTarget(filePath);
  const bytes = readFileSync(filePath);
  if (bytes.byteLength > MAX_RECOVERY_PAYLOAD_BYTES || sha256Hex(bytes) !== reference.hash) {
    throw error('recovery-evidence-storage', 'recovery artifact failed hash verification');
  }
  return JSON.parse(bytes.toString('utf8'));
}

/** Reconstruct a verified hash-bearing reference from an outbox path. */
export function recoveryReferenceFromPath(
  ref: SessionRef,
  referencePath: string,
): RecoveryEvidenceRef {
  if (!referencePath.startsWith(`${RECOVERY_ROOT}/`)) {
    throw error(
      'recovery-evidence-storage',
      'recovery outbox payload reference is outside the recovery namespace',
    );
  }
  const match = /-([a-f0-9]{64})\.json$/u.exec(referencePath);
  if (match === null || match[1] === undefined) {
    throw error(
      'recovery-evidence-storage',
      'recovery outbox payload reference has no deterministic hash',
    );
  }
  const reference = { revision: 1, hash: match[1], path: referencePath };
  const parsed = recoveryReferenceSchema.safeParse(reference);
  if (!parsed.success)
    throw error('recovery-evidence-storage', 'recovery outbox payload reference is invalid');
  const filePath = join(sessionDir(ref.projectDir, ref.sessionId), referencePath);
  const projectRelative = relative(ref.projectDir, filePath).split(sep).join('/');
  assertExistingPathConfined(projectRelative, ref.projectDir);
  return parsed.data;
}
