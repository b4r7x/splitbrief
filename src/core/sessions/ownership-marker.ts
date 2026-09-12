import { randomUUID } from 'node:crypto';
import {
  constants,
  closeSync,
  fstatSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  assertExistingPathConfined,
  assertWritablePathConfined,
} from '../../lib/path-confinement.js';
import { isNodeError } from '../../lib/process/errors.js';
import { error, type AppError } from '../../utils/error.js';
import { isRecord } from '../../utils/type-guards.js';
import { SESSIONS_DIR, SPLITBRIEF_DIR } from '../paths.js';
import type { SessionRef } from '../types/session-ref.js';
import {
  assertSessionOwnershipReceipt,
  readActiveRecord,
  type NewSessionOwnership,
} from './active-pointer.js';

type SessionOwnershipMutationBoundary =
  | 'ownership-claim'
  | 'ownership-captured'
  | 'directory-claim'
  | 'directory-captured';

export type SessionOwnershipMutationOptions = Readonly<{
  _beforeMutation?: ((boundary: SessionOwnershipMutationBoundary) => void) | undefined;
}>;

export type SessionDirectoryIdentity = Readonly<{
  dev: bigint;
  ino: bigint;
}>;

type SessionMarkerIdentity = Readonly<{
  dev: bigint;
  ino: bigint;
}>;

type SessionOwnershipSnapshot = Readonly<{
  directory: SessionDirectoryIdentity;
  marker: SessionMarkerIdentity;
  bytes: string;
}>;

type SessionMarkerSnapshot = Readonly<{
  proof: SessionDirectoryIdentity;
  marker: SessionMarkerIdentity;
  bytes: string;
}>;

export type SessionOwnershipProof = Readonly<{
  version: 1;
  sessionId: string;
  generation: string;
  dev: string;
  ino: string;
}>;

export const OWNERSHIP_FILE = '.prepare-owner.json';
const MAX_OWNERSHIP_BYTES = 512n;
const DECIMAL_INTEGER = /^(0|[1-9]\d*)$/;

export function sessionRelativePath(sessionId: string, filename?: string): string {
  return join(SPLITBRIEF_DIR, SESSIONS_DIR, sessionId, ...(filename ? [filename] : []));
}

export function ownershipRelativePath(relativeDirectory: string): string {
  return join(relativeDirectory, OWNERSHIP_FILE);
}

export function ownershipFailure(ref: SessionRef, reason: string): AppError {
  return error(
    'session-prepare-ownership',
    `Session directory ownership check failed for '${ref.sessionId}': ${reason}`,
    { sessionId: ref.sessionId, reason },
  );
}

export function assertOwnershipContext(session: NewSessionOwnership): void {
  assertSessionOwnershipReceipt(session.ownership);
  if (session.ref.sessionId !== session.ownership.sessionId) {
    throw ownershipFailure(session.ref, 'the ownership receipt names another session');
  }
}

export function directoryIdentity(
  ref: SessionRef,
  relativeDirectory: string,
  expected?: SessionDirectoryIdentity,
): SessionDirectoryIdentity {
  assertExistingPathConfined(relativeDirectory, ref.projectDir);
  const stat = lstatSync(join(ref.projectDir, relativeDirectory), { bigint: true });
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw ownershipFailure(ref, 'the session path is not a real directory');
  }
  const identity = { dev: stat.dev, ino: stat.ino };
  if (expected && (identity.dev !== expected.dev || identity.ino !== expected.ino)) {
    throw ownershipFailure(ref, 'the session directory was replaced');
  }
  return identity;
}

function readOwnershipMarker(
  session: NewSessionOwnership,
  relativePath: string,
): SessionMarkerSnapshot {
  assertExistingPathConfined(relativePath, session.ref.projectDir);
  const marker = join(session.ref.projectDir, relativePath);
  const descriptor = openSync(marker, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(descriptor, { bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n || (stat.mode & 0o077n) !== 0n) {
      throw ownershipFailure(session.ref, 'the ownership marker is not a private regular file');
    }
    if (stat.size === 0n || stat.size > MAX_OWNERSHIP_BYTES) {
      throw ownershipFailure(session.ref, 'the ownership marker has an invalid size');
    }
    const bytes = readFileSync(descriptor, 'utf8');
    const value: unknown = JSON.parse(bytes);
    if (!isRecord(value)) {
      throw ownershipFailure(session.ref, 'the ownership marker is not an object');
    }
    if (Object.keys(value).sort().join(',') !== 'dev,generation,ino,sessionId,version') {
      throw ownershipFailure(session.ref, 'the ownership marker has unexpected fields');
    }
    if (
      value.version !== 1 ||
      value.sessionId !== session.ownership.sessionId ||
      value.generation !== session.ownership.generation ||
      typeof value.dev !== 'string' ||
      !DECIMAL_INTEGER.test(value.dev) ||
      typeof value.ino !== 'string' ||
      !DECIMAL_INTEGER.test(value.ino)
    ) {
      throw ownershipFailure(session.ref, 'the ownership marker does not match this preparation');
    }
    return {
      proof: { dev: BigInt(value.dev), ino: BigInt(value.ino) },
      marker: { dev: stat.dev, ino: stat.ino },
      bytes,
    };
  } finally {
    closeSync(descriptor);
  }
}

export function assertOwnedDirectory(
  session: NewSessionOwnership,
  relativeDirectory: string,
  expected?: SessionDirectoryIdentity,
): SessionOwnershipSnapshot {
  assertOwnershipContext(session);
  const marker = readOwnershipMarker(session, ownershipRelativePath(relativeDirectory));
  if (expected && (marker.proof.dev !== expected.dev || marker.proof.ino !== expected.ino)) {
    throw ownershipFailure(session.ref, 'the ownership marker does not match this allocation');
  }
  return {
    directory: directoryIdentity(session.ref, relativeDirectory, marker.proof),
    marker: marker.marker,
    bytes: marker.bytes,
  };
}

export function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (cause) {
    if (isNodeError(cause) && cause.code === 'ENOENT') return false;
    throw cause;
  }
}

export function claimRelativePath(ref: SessionRef, subject: 'directory' | 'owner'): string {
  return sessionRelativePath(`.${ref.sessionId}.${subject}.${randomUUID()}.claim`);
}

export function removeOwnershipProofLocked(
  session: NewSessionOwnership,
  options: SessionOwnershipMutationOptions = {},
): void {
  const relativeDirectory = sessionRelativePath(session.ref.sessionId);
  const marker = ownershipRelativePath(relativeDirectory);
  const snapshot = assertOwnedDirectory(session, relativeDirectory);
  const claim = claimRelativePath(session.ref, 'owner');
  const markerPath = join(session.ref.projectDir, marker);
  const claimPath = join(session.ref.projectDir, claim);
  assertWritablePathConfined(marker, session.ref.projectDir);
  assertWritablePathConfined(claim, session.ref.projectDir);
  options._beforeMutation?.('ownership-claim');
  renameSync(markerPath, claimPath);
  options._beforeMutation?.('ownership-captured');

  let captured: SessionMarkerSnapshot;
  try {
    captured = readOwnershipMarker(session, claim);
  } catch (cause) {
    try {
      linkSync(claimPath, markerPath);
      unlinkSync(claimPath);
    } catch {
      throw ownershipFailure(session.ref, 'the claimed ownership marker was preserved');
    }
    throw cause;
  }
  if (
    captured.marker.dev !== snapshot.marker.dev ||
    captured.marker.ino !== snapshot.marker.ino ||
    captured.bytes !== snapshot.bytes
  ) {
    try {
      linkSync(claimPath, markerPath);
      unlinkSync(claimPath);
    } catch {
      throw ownershipFailure(session.ref, 'the replaced ownership marker was preserved');
    }
    throw ownershipFailure(session.ref, 'the ownership marker changed before its claim');
  }
  directoryIdentity(session.ref, relativeDirectory, snapshot.directory);
  if (pathExists(markerPath)) {
    throw ownershipFailure(session.ref, 'a newer ownership marker appeared after the claim');
  }
  unlinkSync(claimPath);
}

export function assertNoNewerSameSessionActive(session: NewSessionOwnership): void {
  const active = readActiveRecord(session.ref.projectDir);
  if (active === null) return;
  if (active.kind === 'legacy') {
    if (active.sessionId === session.ref.sessionId) {
      throw ownershipFailure(session.ref, 'active ownership cannot be proven');
    }
    return;
  }
  if (
    active.receipt.sessionId === session.ref.sessionId &&
    active.receipt.generation !== session.ownership.generation
  ) {
    throw ownershipFailure(session.ref, 'a newer activation owns this session ID');
  }
}
