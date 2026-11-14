import {
  constants,
  closeSync,
  fchmodSync,
  fsyncSync,
  linkSync,
  openSync,
  writeSync,
} from 'node:fs';
import { fsError, SECURE_FILE_MODE } from '../../secure.js';
import type { AtomicSyncFileHandle, AtomicSyncLock, AtomicTarget } from '../types.js';
import { removeAtomicLockOwnerSync } from './removal-sync.js';
import { assertAtomicDirectoryIdentitySync, isAlreadyExists } from '../target.js';
import { removeTemporaryFileSync } from '../temporary.js';
import {
  atomicLockPath,
  atomicLockOwner,
  serializeAtomicLockOwner,
  atomicLockCandidatePath,
  observeAtomicLockSync,
  atomicLockOwnerState,
  ATOMIC_LOCK_RETRY_MS,
} from './owner.js';

function writeAtomicLockOwnerSync(handle: AtomicSyncFileHandle, rawOwner: string): void {
  const bytes = Buffer.from(rawOwner);
  let offset = 0;
  while (offset < bytes.byteLength) {
    const bytesWritten = writeSync(handle, bytes, offset, bytes.byteLength - offset, offset);
    if (bytesWritten <= 0 || bytesWritten > bytes.byteLength - offset) {
      throw fsError.invalidId(
        'atomic lock write length',
        String(bytesWritten),
        'must advance within bytes',
      );
    }
    offset += bytesWritten;
  }
}

export function acquireAtomicLockSync(
  target: AtomicTarget,
  beforePublish: (path: string) => void,
  beforeMove: (path: string) => void,
): AtomicSyncLock {
  const path = atomicLockPath(target);
  const owner = atomicLockOwner();
  const rawOwner = serializeAtomicLockOwner(owner);
  const candidatePath = atomicLockCandidatePath(path, owner);
  while (true) {
    assertAtomicDirectoryIdentitySync(target);
    let handle: AtomicSyncFileHandle;
    try {
      handle = openSync(
        candidatePath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        SECURE_FILE_MODE,
      );
    } catch (err) {
      if (isAlreadyExists(err)) {
        throw fsError.invalidId('atomic lock candidate', candidatePath, 'already exists');
      }
      throw err;
    }

    try {
      fchmodSync(handle, SECURE_FILE_MODE);
      writeAtomicLockOwnerSync(handle, rawOwner);
      fsyncSync(handle);
      closeSync(handle);
      assertAtomicDirectoryIdentitySync(target);
      try {
        beforePublish(path);
        assertAtomicDirectoryIdentitySync(target);
        linkSync(candidatePath, path);
      } catch (err) {
        if (!isAlreadyExists(err)) throw err;
        removeTemporaryFileSync(candidatePath, target);
        const observed = observeAtomicLockSync(target, path);
        if (observed === null) continue;
        if (observed.owner === null) {
          throw fsError.invalidId('atomic lock', path, 'owner identity is not valid');
        }
        if (atomicLockOwnerState(observed.owner) === 'dead') {
          if (
            removeAtomicLockOwnerSync(target, path, observed.rawOwner, observed.owner, beforeMove)
          )
            continue;
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ATOMIC_LOCK_RETRY_MS);
        continue;
      }
      assertAtomicDirectoryIdentitySync(target);
      removeTemporaryFileSync(candidatePath, target);
      return { path, rawOwner, owner };
    } catch (err) {
      try {
        closeSync(handle);
      } catch {
        // Continue to remove the unpublished candidate after a preparation failure.
      }
      removeTemporaryFileSync(candidatePath, target);
      throw err;
    }
  }
}

export function releaseAtomicLockSync(
  target: AtomicTarget,
  lock: AtomicSyncLock,
  beforeMove: (path: string) => void,
): void {
  let beforeMoveFailed = false;
  let beforeMoveError: unknown;
  const guardedBeforeMove = (path: string): void => {
    try {
      beforeMove(path);
    } catch (cause) {
      beforeMoveFailed = true;
      beforeMoveError = cause;
      throw cause;
    }
  };
  try {
    removeAtomicLockOwnerSync(target, lock.path, lock.rawOwner, lock.owner, guardedBeforeMove);
  } catch {
    if (beforeMoveFailed) throw beforeMoveError;
    // A release failure must not replace the write result or unlink a successor.
  }
}
