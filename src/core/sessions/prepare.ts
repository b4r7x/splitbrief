import { randomUUID } from 'node:crypto';
import {
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { confinedEnsureDir } from '../../lib/confined-fs.js';
import { SECURE_DIR_MODE, SECURE_FILE_MODE, writeSecureFile } from '../../lib/fs.js';
import { assertWritablePathConfined } from '../../lib/path-confinement.js';
import { isNodeError } from '../../lib/process/errors.js';
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
  readActiveRecord,
  withSessionMutationLock,
  writeActiveReceiptLocked,
  type ActiveSessionReceipt,
  type NewSessionOwnership,
  type PreparedNewSession,
  type SessionOwnershipReceipt,
} from './active-pointer.js';
import { isSessionLive } from './liveness.js';
import { generateSessionId } from './session-id.js';
import {
  assertHandedOffDirectory,
  assertNoNewerSameSessionActive,
  assertOwnedDirectory,
  assertOwnershipContext,
  claimRelativePath,
  directoryIdentity,
  ownershipFailure,
  ownershipRelativePath,
  pathExists,
  removeOwnershipProofLocked,
  sessionPreparationError,
  sessionRelativePath,
  OWNERSHIP_FILE,
  type SessionDirectoryIdentity,
  type SessionOwnershipMutationOptions,
  type SessionOwnershipProof,
} from './ownership-marker.js';

export type SessionMutationBoundary = 'allocation' | 'readiness' | 'active';

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

function abortBefore(input: PrepareNewSessionInput, boundary: SessionMutationBoundary): boolean {
  input._beforeMutation?.(boundary);
  return input.signal?.aborted === true;
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

export function rollbackPreparedSessionLocked(
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
      generateSessionId({
        projectDir: input.projectDir,
        feature: input.feature,
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

function cleanupAfterReadinessFailure(session: NewSessionOwnership, keepDirectory: boolean): void {
  withSessionMutationLock(session.ref.projectDir, () => {
    if (keepDirectory) removeOwnershipProofLocked(session);
    else rollbackPreparedSessionLocked(session);
  });
}

// Starting a run is the one flow allowed to clear the active pointer (guards.ts): until
// then it is what `resume` resumes from. The caller's mutation lock makes the liveness
// test and the replacing write atomic; a live pointer stays and still conflicts below.
function clearStaleActiveReceiptLocked(ref: SessionRef): void {
  const active = readActiveRecord(ref.projectDir);
  if (active?.kind !== 'v1') return;
  const recorded: SessionRef = { projectDir: ref.projectDir, sessionId: active.receipt.sessionId };
  if (isSessionLive(recorded)) return;
  clearActiveReceiptLocked(recorded, active.receipt);
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
        clearStaleActiveReceiptLocked(ref);
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
