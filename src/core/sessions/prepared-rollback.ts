import { renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { assertWritablePathConfined } from '../../lib/fs/confinement.js';
import {
  clearActiveReceiptLocked,
  withSessionMutationLock,
  type ActiveSessionReceipt,
  type NewSessionOwnership,
} from './active-pointer.js';
import {
  type SessionOwnershipMutationOptions,
  sessionRelativePath,
  assertOwnedDirectory,
  assertNoNewerSameSessionActive,
  claimRelativePath,
  ownershipFailure,
  pathExists,
  assertOwnershipContext,
  removeOwnershipProofLocked,
} from './ownership-marker.js';
import { sessionDir } from '../paths.js';
import { sessionPreparationError } from './errors.js';
import { tryClaimSession } from './lock/ownership.js';
import { checkSessionLockStatus } from './lock/status.js';

function claimOwnedDirectoryLocked(
  session: NewSessionOwnership,
  options: SessionOwnershipMutationOptions,
): string {
  const original = sessionRelativePath(session.ref.sessionId);
  const snapshot = assertOwnedDirectory(session, original);
  assertNoNewerSameSessionActive(session);
  const claim = claimRelativePath(session.ref, 'directory');
  const originalPath = join(session.ref.projectDir, original);
  const claimPath = join(session.ref.projectDir, claim);
  assertWritablePathConfined(original, session.ref.projectDir);
  assertWritablePathConfined(claim, session.ref.projectDir);
  options._beforeMutation?.('directory-claim');
  renameSync(originalPath, claimPath);
  options._beforeMutation?.('directory-captured');

  const captured = assertOwnedDirectory(session, claim, snapshot.directory);
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

export function rollbackPreparedSessionLocked(
  session: NewSessionOwnership,
  options: SessionOwnershipMutationOptions = {},
): void {
  assertOwnershipContext(session);
  const canonical = sessionDir(session.ref.projectDir, session.ref.sessionId);
  if (!pathExists(canonical)) return;

  const release = tryClaimSession(session.ref);
  if (release === null) throw ownershipFailure(session.ref, 'the session is in use');
  try {
    const status = checkSessionLockStatus({
      sessionDir: canonical,
      expectedSessionId: session.ref.sessionId,
    });
    if (status.kind === 'live' || status.kind === 'stale' || status.kind === 'invalid') {
      throw ownershipFailure(session.ref, 'the session may still be in use');
    }
    const claim = claimOwnedDirectoryLocked(session, options);
    assertNoNewerSameSessionActive(session);
    const initialActive: ActiveSessionReceipt = session.ownership;
    clearActiveReceiptLocked(session.ref, initialActive);
    if (pathExists(canonical)) {
      throw ownershipFailure(session.ref, 'the canonical session path was recreated');
    }
    rmSync(join(session.ref.projectDir, claim), { recursive: true });
  } finally {
    release();
  }
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
