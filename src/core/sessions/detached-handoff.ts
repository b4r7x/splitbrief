import { join } from 'node:path';
import { linkSync } from 'node:fs';
import { assertWritablePathConfined } from '../../lib/path-confinement.js';
import { sessionDir } from '../paths.js';
import { withSessionMutationLock, type NewSessionOwnership } from './active-pointer.js';
import {
  assertExactActiveReceipt,
  assertHandedOffDirectory,
  assertOwnedDirectory,
  assertOwnershipContext,
  detachedHandoffRelativePath,
  ownershipFailure,
  ownershipRelativePath,
  pathExists,
  removeExactMarkerPathLocked,
  removeOwnershipProofLocked,
  sessionPreparationError,
  sessionRelativePath,
  type SessionOwnershipMutationOptions,
} from './ownership-marker.js';
import { rollbackPreparedSessionLocked } from './prepare.js';

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
