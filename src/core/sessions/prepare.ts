import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { confinedEnsureDir } from '../../lib/confined-fs.js';
import { SECURE_DIR_MODE, SECURE_FILE_MODE, writeSecureFile } from '../../lib/fs.js';
import {
  assertExistingPathConfined,
  assertWritablePathConfined,
} from '../../lib/path-confinement.js';
import { isNodeError } from '../../lib/process/errors.js';
import { error, type AppError } from '../../utils/error.js';
import { isRecord } from '../../utils/type-guards.js';
import type { DeepReadonly } from '../config/accessors/runner-config.js';
import {
  READINESS_FILE,
  sessionDir,
  SESSIONS_DIR,
  SPLITBRIEF_DIR,
  validateSessionId,
} from '../paths.js';
import { createStartReadinessRecord } from '../readiness/format.js';
import type { ReadinessReport } from '../readiness/types.js';
import type { Config } from '../schemas/config.js';
import type { SessionRef } from '../types/session-ref.js';
import {
  assertSessionOwnershipReceipt,
  clearActiveReceiptLocked,
  generateSessionId,
  readActiveRecord,
  withSessionMutationLock,
  writeActiveReceiptLocked,
  type ActiveSessionReceipt,
  type NewSessionOwnership,
  type PreparedNewSession,
  type SessionOwnershipReceipt,
} from './lifecycle.js';

export type {
  ActiveSessionReceipt,
  NewSessionOwnership,
  PreparedNewSession,
  SessionOwnershipReceipt,
} from './lifecycle.js';

export type SessionPreparationOperation =
  | 'allocate-session'
  | 'write-readiness'
  | 'publish-active'
  | 'release-session'
  | 'rollback-session'
  | 'transfer-detached-session'
  | 'accept-detached-session'
  | 'settle-detached-session'
  | 'rollback-detached-session'
  | 'discard-orphan-session';

type SessionPreparationErrorData = Readonly<{
  operation: SessionPreparationOperation;
  sessionId: string;
}>;

export type SessionPreparationIoError = AppError<'session-prepare-io', SessionPreparationErrorData>;

export const sessionPreparationError = {
  io: (
    operation: SessionPreparationOperation,
    ref: SessionRef,
    cause: unknown,
  ): SessionPreparationIoError =>
    error(
      'session-prepare-io',
      `Failed to ${operation.replaceAll('-', ' ')} for session '${ref.sessionId}'`,
      { operation, sessionId: ref.sessionId },
      cause,
    ),
} as const;

export type SessionMutationBoundary = 'allocation' | 'readiness' | 'active';

export type SessionOwnershipMutationBoundary =
  | 'ownership-claim'
  | 'ownership-captured'
  | 'directory-claim'
  | 'directory-captured'
  | 'detached-alias-claim'
  | 'detached-alias-captured'
  | 'detached-recovery-claim'
  | 'detached-recovery-captured';

export type SessionOwnershipMutationOptions = Readonly<{
  _beforeMutation?: ((boundary: SessionOwnershipMutationBoundary) => void) | undefined;
}>;

export type PrepareNewSessionInput = Readonly<{
  projectDir: string;
  feature: string;
  config: DeepReadonly<Config>;
  report: ReadinessReport;
  signal?: AbortSignal | undefined;
  candidate?: SessionOwnershipReceipt | undefined;
  _beforeMutation?: ((boundary: SessionMutationBoundary) => void) | undefined;
}>;

export type PrepareNewSessionResult =
  | Readonly<{ kind: 'prepared'; session: PreparedNewSession }>
  | Readonly<{ kind: 'aborted' }>;

type SessionDirectoryIdentity = Readonly<{
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

type SessionOwnershipProof = Readonly<{
  version: 1;
  sessionId: string;
  generation: string;
  dev: string;
  ino: string;
}>;

const OWNERSHIP_FILE = '.prepare-owner.json';
const DETACHED_HANDOFF_FILE = '.detached-handoff.json';
const MAX_OWNERSHIP_BYTES = 512n;
const DECIMAL_INTEGER = /^(0|[1-9]\d*)$/;

function sessionRelativePath(sessionId: string, filename?: string): string {
  return join(SPLITBRIEF_DIR, SESSIONS_DIR, sessionId, ...(filename ? [filename] : []));
}

function ownershipRelativePath(relativeDirectory: string): string {
  return join(relativeDirectory, OWNERSHIP_FILE);
}

function detachedHandoffRelativePath(relativeDirectory: string): string {
  return join(relativeDirectory, DETACHED_HANDOFF_FILE);
}

function abortBefore(input: PrepareNewSessionInput, boundary: SessionMutationBoundary): boolean {
  input._beforeMutation?.(boundary);
  return input.signal?.aborted === true;
}

function ownershipFailure(ref: SessionRef, reason: string): AppError {
  return error(
    'session-prepare-ownership',
    `Session directory ownership check failed for '${ref.sessionId}': ${reason}`,
    { sessionId: ref.sessionId, reason },
  );
}

function assertOwnershipContext(session: NewSessionOwnership): void {
  assertSessionOwnershipReceipt(session.ownership);
  if (session.ref.sessionId !== session.ownership.sessionId) {
    throw ownershipFailure(session.ref, 'the ownership receipt names another session');
  }
}

function directoryIdentity(
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
  allowOwnerAlias = false,
): SessionMarkerSnapshot {
  assertExistingPathConfined(relativePath, session.ref.projectDir);
  const marker = join(session.ref.projectDir, relativePath);
  const descriptor = openSync(marker, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(descriptor, { bigint: true });
    if (
      !stat.isFile() ||
      (stat.nlink !== 1n && (!allowOwnerAlias || stat.nlink !== 2n)) ||
      (stat.mode & 0o077n) !== 0n
    ) {
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

function assertOwnedDirectory(
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

function assertHandedOffDirectory(
  session: NewSessionOwnership,
  relativeDirectory: string,
  expected?: SessionDirectoryIdentity,
  allowOwnerAlias = false,
): SessionOwnershipSnapshot {
  assertOwnershipContext(session);
  const marker = readOwnershipMarker(
    session,
    detachedHandoffRelativePath(relativeDirectory),
    allowOwnerAlias,
  );
  if (expected && (marker.proof.dev !== expected.dev || marker.proof.ino !== expected.ino)) {
    throw ownershipFailure(session.ref, 'the detached handoff does not match this allocation');
  }
  return {
    directory: directoryIdentity(session.ref, relativeDirectory, marker.proof),
    marker: marker.marker,
    bytes: marker.bytes,
  };
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (cause) {
    if (isNodeError(cause) && cause.code === 'ENOENT') return false;
    throw cause;
  }
}

function claimRelativePath(ref: SessionRef, subject: 'directory' | 'owner'): string {
  return sessionRelativePath(`.${ref.sessionId}.${subject}.${randomUUID()}.claim`);
}

function removeExactMarkerPathLocked(
  input: Readonly<{
    session: NewSessionOwnership;
    source: string;
    expected: SessionMarkerIdentity;
    options: SessionOwnershipMutationOptions;
    boundary: 'detached-alias' | 'detached-recovery';
  }>,
): void {
  const claim = claimRelativePath(input.session.ref, 'owner');
  const sourcePath = join(input.session.ref.projectDir, input.source);
  const claimPath = join(input.session.ref.projectDir, claim);
  assertWritablePathConfined(input.source, input.session.ref.projectDir);
  assertWritablePathConfined(claim, input.session.ref.projectDir);
  input.options._beforeMutation?.(`${input.boundary}-claim`);
  renameSync(sourcePath, claimPath);
  input.options._beforeMutation?.(`${input.boundary}-captured`);
  if (pathExists(sourcePath)) {
    const replacement = claimRelativePath(input.session.ref, 'owner');
    assertWritablePathConfined(replacement, input.session.ref.projectDir);
    renameSync(sourcePath, join(input.session.ref.projectDir, replacement));
  }
  const claimed = lstatSync(claimPath, { bigint: true });
  if (claimed.dev === input.expected.dev && claimed.ino === input.expected.ino) {
    unlinkSync(claimPath);
  }
}

function removeOwnershipProofLocked(
  session: NewSessionOwnership,
  options: SessionOwnershipMutationOptions = {},
  proof: 'ownership' | 'detached-handoff' = 'ownership',
): void {
  const relativeDirectory = sessionRelativePath(session.ref.sessionId);
  const marker =
    proof === 'ownership'
      ? ownershipRelativePath(relativeDirectory)
      : detachedHandoffRelativePath(relativeDirectory);
  const snapshot =
    proof === 'ownership'
      ? assertOwnedDirectory(session, relativeDirectory)
      : assertHandedOffDirectory(session, relativeDirectory);
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

function assertNoNewerSameSessionActive(session: NewSessionOwnership): void {
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

function assertExactActiveReceipt(session: NewSessionOwnership): void {
  const active = readActiveRecord(session.ref.projectDir);
  if (
    active?.kind !== 'v1' ||
    active.receipt.version !== session.ownership.version ||
    active.receipt.sessionId !== session.ownership.sessionId ||
    active.receipt.generation !== session.ownership.generation
  ) {
    throw ownershipFailure(session.ref, 'active ownership does not match this preparation');
  }
}

function claimOwnedDirectoryLocked(
  session: NewSessionOwnership,
  options: SessionOwnershipMutationOptions,
  proof: 'ownership' | 'detached-handoff' = 'ownership',
): string {
  const original = sessionRelativePath(session.ref.sessionId);
  const snapshot =
    proof === 'ownership'
      ? assertOwnedDirectory(session, original)
      : assertHandedOffDirectory(session, original);
  assertNoNewerSameSessionActive(session);
  const claim = claimRelativePath(session.ref, 'directory');
  const originalPath = join(session.ref.projectDir, original);
  const claimPath = join(session.ref.projectDir, claim);
  assertWritablePathConfined(original, session.ref.projectDir);
  assertWritablePathConfined(claim, session.ref.projectDir);
  options._beforeMutation?.('directory-claim');
  renameSync(originalPath, claimPath);
  options._beforeMutation?.('directory-captured');

  const captured =
    proof === 'ownership'
      ? assertOwnedDirectory(session, claim, snapshot.directory)
      : assertHandedOffDirectory(session, claim, snapshot.directory);
  if (
    captured.marker.dev !== snapshot.marker.dev ||
    captured.marker.ino !== snapshot.marker.ino ||
    captured.bytes !== snapshot.bytes
  ) {
    throw ownershipFailure(session.ref, 'the ownership proof changed during quarantine');
  }
  if (pathExists(originalPath)) {
    throw ownershipFailure(session.ref, 'the canonical session path was recreated');
  }
  return claim;
}

function removeAllocatedDirectory(ref: SessionRef, identity: SessionDirectoryIdentity): void {
  const original = sessionRelativePath(ref.sessionId);
  directoryIdentity(ref, original, identity);
  const claim = claimRelativePath(ref, 'directory');
  const originalPath = join(ref.projectDir, original);
  const claimPath = join(ref.projectDir, claim);
  assertWritablePathConfined(original, ref.projectDir);
  assertWritablePathConfined(claim, ref.projectDir);
  renameSync(originalPath, claimPath);
  directoryIdentity(ref, claim, identity);
  if (pathExists(originalPath)) {
    throw ownershipFailure(ref, 'the canonical session path was recreated');
  }
  rmSync(claimPath, { recursive: true });
}

function activeRecordNamesSession(ref: SessionRef): boolean {
  const active = readActiveRecord(ref.projectDir);
  if (active === null) return false;
  const activeSessionId = active.kind === 'legacy' ? active.sessionId : active.receipt.sessionId;
  return activeSessionId === ref.sessionId;
}

function isCollectableOrphanDirectory(ref: SessionRef, relativeDirectory: string): boolean {
  const entries = readdirSync(join(ref.projectDir, relativeDirectory));
  if (entries.length === 0) return true;
  if (entries.length !== 1 || entries[0] !== READINESS_FILE) return false;
  return lstatSync(join(ref.projectDir, relativeDirectory, READINESS_FILE)).isFile();
}

function discardOrphanSessionDirectoryLocked(ref: SessionRef): boolean {
  if (activeRecordNamesSession(ref)) return false;
  const original = sessionRelativePath(ref.sessionId);
  const originalPath = join(ref.projectDir, original);
  if (!pathExists(originalPath)) return false;
  const identity = directoryIdentity(ref, original);
  if (!isCollectableOrphanDirectory(ref, original)) return false;
  const claim = claimRelativePath(ref, 'directory');
  const claimPath = join(ref.projectDir, claim);
  assertWritablePathConfined(original, ref.projectDir);
  assertWritablePathConfined(claim, ref.projectDir);
  renameSync(originalPath, claimPath);
  directoryIdentity(ref, claim, identity);
  if (!isCollectableOrphanDirectory(ref, claim)) {
    if (pathExists(originalPath)) {
      throw ownershipFailure(ref, 'the canonical session path was recreated');
    }
    renameSync(claimPath, originalPath);
    return false;
  }
  if (pathExists(originalPath)) {
    throw ownershipFailure(ref, 'the canonical session path was recreated');
  }
  rmSync(claimPath, { recursive: true });
  return true;
}

export function discardOrphanSessionDirectory(ref: SessionRef): boolean {
  try {
    validateSessionId(ref.sessionId);
    return withSessionMutationLock(ref.projectDir, () => discardOrphanSessionDirectoryLocked(ref));
  } catch (cause) {
    throw sessionPreparationError.io('discard-orphan-session', ref, cause);
  }
}

function rollbackPreparedSessionLocked(
  session: NewSessionOwnership,
  options: SessionOwnershipMutationOptions = {},
  proof: 'ownership' | 'detached-handoff' = 'ownership',
): void {
  assertOwnershipContext(session);
  const canonical = sessionDir(session.ref.projectDir, session.ref.sessionId);
  if (!pathExists(canonical)) return;

  const claim = claimOwnedDirectoryLocked(session, options, proof);
  assertNoNewerSameSessionActive(session);
  const initialActive: ActiveSessionReceipt = session.ownership;
  clearActiveReceiptLocked(session.ref, initialActive);
  if (pathExists(canonical)) {
    throw ownershipFailure(session.ref, 'the canonical session path was recreated');
  }
  rmSync(join(session.ref.projectDir, claim), { recursive: true });
}

export function createSessionPreparationCandidate(
  input: Readonly<{
    projectDir: string;
    feature: string;
    persistTranscript: boolean;
    sessionId?: string | undefined;
  }>,
): SessionOwnershipReceipt {
  const receipt: SessionOwnershipReceipt = {
    version: 1,
    sessionId:
      input.sessionId ??
      generateSessionId(input.projectDir, input.feature, new Date(), {
        persistTranscript: input.persistTranscript,
      }),
    generation: randomUUID(),
  };
  assertSessionOwnershipReceipt(receipt);
  return receipt;
}

export function rollbackPreparedSession(
  session: NewSessionOwnership,
  options: SessionOwnershipMutationOptions = {},
): void {
  try {
    assertOwnershipContext(session);
    withSessionMutationLock(session.ref.projectDir, () =>
      rollbackPreparedSessionLocked(session, options),
    );
  } catch (cause) {
    throw sessionPreparationError.io('rollback-session', session.ref, cause);
  }
}

export function releasePreparedSession(
  session: NewSessionOwnership,
  options: SessionOwnershipMutationOptions = {},
): void {
  try {
    assertOwnershipContext(session);
    withSessionMutationLock(session.ref.projectDir, () =>
      removeOwnershipProofLocked(session, options),
    );
  } catch (cause) {
    throw sessionPreparationError.io('release-session', session.ref, cause);
  }
}

function transferPreparedSessionToDetachedLocked(
  session: NewSessionOwnership,
  options: SessionOwnershipMutationOptions,
): void {
  const relativeDirectory = sessionRelativePath(session.ref.sessionId);
  const ownership = ownershipRelativePath(relativeDirectory);
  const handoff = detachedHandoffRelativePath(relativeDirectory);
  const snapshot = assertOwnedDirectory(session, relativeDirectory);
  const ownershipPath = join(session.ref.projectDir, ownership);
  const handoffPath = join(session.ref.projectDir, handoff);
  assertWritablePathConfined(ownership, session.ref.projectDir);
  assertWritablePathConfined(handoff, session.ref.projectDir);
  assertExactActiveReceipt(session);
  options._beforeMutation?.('ownership-claim');
  linkSync(ownershipPath, handoffPath);

  try {
    options._beforeMutation?.('ownership-captured');
    const captured = assertHandedOffDirectory(session, relativeDirectory, snapshot.directory, true);
    if (
      captured.marker.dev !== snapshot.marker.dev ||
      captured.marker.ino !== snapshot.marker.ino ||
      captured.bytes !== snapshot.bytes
    ) {
      throw ownershipFailure(session.ref, 'the ownership proof changed during detached handoff');
    }
    assertExactActiveReceipt(session);
  } catch (cause) {
    removeExactMarkerPathLocked({
      session,
      source: handoff,
      expected: snapshot.marker,
      options,
      boundary: 'detached-recovery',
    });
    throw cause;
  }
}

function normalizeDetachedOwnerAliasLocked(
  session: NewSessionOwnership,
  relativeDirectory: string,
  options: SessionOwnershipMutationOptions,
): void {
  const handoff = assertHandedOffDirectory(session, relativeDirectory, undefined, true);
  const ownership = ownershipRelativePath(relativeDirectory);
  const ownershipPath = join(session.ref.projectDir, ownership);
  if (pathExists(ownershipPath)) {
    removeExactMarkerPathLocked({
      session,
      source: ownership,
      expected: handoff.marker,
      options,
      boundary: 'detached-alias',
    });
  }
  const normalized = assertHandedOffDirectory(session, relativeDirectory, handoff.directory);
  if (
    normalized.marker.dev !== handoff.marker.dev ||
    normalized.marker.ino !== handoff.marker.ino ||
    normalized.bytes !== handoff.bytes
  ) {
    throw ownershipFailure(session.ref, 'the detached handoff changed during alias cleanup');
  }
}

export function transferPreparedSessionToDetached(
  session: NewSessionOwnership,
  options: SessionOwnershipMutationOptions = {},
): void {
  try {
    assertOwnershipContext(session);
    withSessionMutationLock(session.ref.projectDir, () =>
      transferPreparedSessionToDetachedLocked(session, options),
    );
  } catch (cause) {
    throw sessionPreparationError.io('transfer-detached-session', session.ref, cause);
  }
}

function acceptDetachedSessionHandoffLocked(
  session: NewSessionOwnership,
  options: SessionOwnershipMutationOptions,
): boolean {
  const relativeDirectory = sessionRelativePath(session.ref.sessionId);
  const canonical = sessionDir(session.ref.projectDir, session.ref.sessionId);
  if (!pathExists(canonical)) return false;
  if (!pathExists(join(session.ref.projectDir, detachedHandoffRelativePath(relativeDirectory)))) {
    return false;
  }
  normalizeDetachedOwnerAliasLocked(session, relativeDirectory, options);
  assertExactActiveReceipt(session);
  removeOwnershipProofLocked(session, options, 'detached-handoff');
  return true;
}

export function acceptDetachedSessionHandoff(
  session: NewSessionOwnership,
  options: SessionOwnershipMutationOptions = {},
): boolean {
  try {
    assertOwnershipContext(session);
    return withSessionMutationLock(session.ref.projectDir, () =>
      acceptDetachedSessionHandoffLocked(session, options),
    );
  } catch (cause) {
    throw sessionPreparationError.io('accept-detached-session', session.ref, cause);
  }
}

export function settleDetachedSessionHandoff(
  session: NewSessionOwnership,
  options: SessionOwnershipMutationOptions = {},
): 'accepted' | 'rolled-back' {
  try {
    assertOwnershipContext(session);
    return withSessionMutationLock(session.ref.projectDir, () => {
      if (acceptDetachedSessionHandoffLocked(session, options)) return 'accepted';
      rollbackPreparedSessionLocked(session, options);
      return 'rolled-back';
    });
  } catch (cause) {
    throw sessionPreparationError.io('settle-detached-session', session.ref, cause);
  }
}

export function rollbackDetachedSessionHandoff(
  session: NewSessionOwnership,
  options: SessionOwnershipMutationOptions = {},
): void {
  try {
    assertOwnershipContext(session);
    withSessionMutationLock(session.ref.projectDir, () => {
      const relativeDirectory = sessionRelativePath(session.ref.sessionId);
      if (pathExists(sessionDir(session.ref.projectDir, session.ref.sessionId))) {
        normalizeDetachedOwnerAliasLocked(session, relativeDirectory, options);
      }
      rollbackPreparedSessionLocked(session, options, 'detached-handoff');
    });
  } catch (cause) {
    throw sessionPreparationError.io('rollback-detached-session', session.ref, cause);
  }
}

function cleanupAfterReadinessFailure(session: NewSessionOwnership, keepDirectory: boolean): void {
  withSessionMutationLock(session.ref.projectDir, () => {
    if (keepDirectory) removeOwnershipProofLocked(session);
    else rollbackPreparedSessionLocked(session);
  });
}

export function prepareNewSession(input: PrepareNewSessionInput): PrepareNewSessionResult {
  const ownership =
    input.candidate ??
    createSessionPreparationCandidate({
      projectDir: input.projectDir,
      feature: input.feature,
      persistTranscript: input.config.workflow.persistTranscript,
    });
  assertSessionOwnershipReceipt(ownership);
  const ref: SessionRef = { projectDir: input.projectDir, sessionId: ownership.sessionId };
  const owned: NewSessionOwnership = { ref, ownership };
  assertOwnershipContext(owned);

  if (abortBefore(input, 'allocation')) return { kind: 'aborted' };
  let allocatedIdentity: SessionDirectoryIdentity | undefined;
  try {
    confinedEnsureDir(ref.projectDir, join(SPLITBRIEF_DIR, SESSIONS_DIR));
    const relativeDirectory = sessionRelativePath(ref.sessionId);
    assertWritablePathConfined(relativeDirectory, ref.projectDir);
    const directory = sessionDir(ref.projectDir, ref.sessionId);
    mkdirSync(directory, { mode: SECURE_DIR_MODE });
    allocatedIdentity = directoryIdentity(ref, relativeDirectory);
    const proof: SessionOwnershipProof = {
      version: 1,
      sessionId: ownership.sessionId,
      generation: ownership.generation,
      dev: allocatedIdentity.dev.toString(),
      ino: allocatedIdentity.ino.toString(),
    };
    const marker = join(directory, OWNERSHIP_FILE);
    assertWritablePathConfined(ownershipRelativePath(relativeDirectory), ref.projectDir);
    writeFileSync(marker, `${JSON.stringify(proof)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: SECURE_FILE_MODE,
    });
    assertOwnedDirectory(owned, relativeDirectory, allocatedIdentity);
  } catch (cause) {
    if (allocatedIdentity) {
      try {
        removeAllocatedDirectory(ref, allocatedIdentity);
      } catch (cleanupCause) {
        throw sessionPreparationError.io('allocate-session', ref, cleanupCause);
      }
    }
    throw sessionPreparationError.io('allocate-session', ref, cause);
  }

  if (abortBefore(input, 'readiness')) {
    try {
      withSessionMutationLock(ref.projectDir, () => rollbackPreparedSessionLocked(owned));
    } catch (cause) {
      throw sessionPreparationError.io('rollback-session', ref, cause);
    }
    return { kind: 'aborted' };
  }

  let linkError: unknown;
  let temporaryCleanupError: unknown;
  try {
    const relativeDirectory = sessionRelativePath(ref.sessionId);
    assertOwnedDirectory(owned, relativeDirectory, allocatedIdentity);
    const directory = sessionDir(ref.projectDir, ref.sessionId);
    const target = join(directory, READINESS_FILE);
    const temporary = join(directory, `.${READINESS_FILE}.${randomUUID()}.tmp`);
    const record = createStartReadinessRecord(input.report);
    assertWritablePathConfined(sessionRelativePath(ref.sessionId, READINESS_FILE), ref.projectDir);
    writeSecureFile(temporary, `${JSON.stringify(record, null, 2)}\n`);
    assertOwnedDirectory(owned, relativeDirectory, allocatedIdentity);
    try {
      linkSync(temporary, target);
    } catch (cause) {
      linkError = cause;
    } finally {
      try {
        rmSync(temporary, { force: true });
      } catch (cause) {
        temporaryCleanupError = cause;
      }
    }
    if (linkError) throw linkError;
    if (temporaryCleanupError) throw temporaryCleanupError;
  } catch (cause) {
    const keepDirectory =
      linkError !== undefined && isNodeError(linkError) && linkError.code === 'EEXIST';
    try {
      cleanupAfterReadinessFailure(owned, keepDirectory);
    } catch (cleanupCause) {
      throw sessionPreparationError.io('write-readiness', ref, cleanupCause);
    }
    throw sessionPreparationError.io('write-readiness', ref, cause);
  }

  try {
    return withSessionMutationLock(ref.projectDir, () => {
      try {
        input._beforeMutation?.('active');
        assertOwnedDirectory(owned, sessionRelativePath(ref.sessionId), allocatedIdentity);
        if (input.signal?.aborted === true) {
          rollbackPreparedSessionLocked(owned);
          return { kind: 'aborted' };
        }
        const active: ActiveSessionReceipt = ownership;
        writeActiveReceiptLocked(ref, active);
        return { kind: 'prepared', session: { ...owned, active } };
      } catch (cause) {
        try {
          rollbackPreparedSessionLocked(owned);
        } catch (cleanupCause) {
          throw sessionPreparationError.io('publish-active', ref, cleanupCause);
        }
        throw cause;
      }
    });
  } catch (cause) {
    if (
      isRecord(cause) &&
      cause.kind === 'session-prepare-io' &&
      isRecord(cause.data) &&
      cause.data.operation === 'publish-active'
    ) {
      throw cause;
    }
    throw sessionPreparationError.io('publish-active', ref, cause);
  }
}
