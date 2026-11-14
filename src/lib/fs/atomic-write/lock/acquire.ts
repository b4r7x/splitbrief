import { constants } from 'node:fs';
import { link, open } from 'node:fs/promises';
import { removeAtomicLockOwner } from './removal.js';
import { fsError, SECURE_FILE_MODE } from '../../secure.js';
import { assertAtomicDirectoryIdentity, isAlreadyExists } from '../target.js';
import { removeTemporaryFile } from '../temporary.js';
import type { AtomicFileHandle, AtomicLock, AtomicTarget } from '../types.js';
import {
  atomicLockPath,
  atomicLockOwner,
  serializeAtomicLockOwner,
  atomicLockCandidatePath,
  observeAtomicLock,
  atomicLockOwnerState,
  ATOMIC_LOCK_RETRY_MS,
} from './owner.js';

async function writeAtomicLockOwner(handle: AtomicFileHandle, rawOwner: string): Promise<void> {
  const bytes = Buffer.from(rawOwner);
  let offset = 0;
  while (offset < bytes.byteLength) {
    const result = await handle.write(bytes, offset, bytes.byteLength - offset, offset);
    if (result.bytesWritten <= 0 || result.bytesWritten > bytes.byteLength - offset) {
      throw fsError.invalidId(
        'atomic lock write length',
        String(result.bytesWritten),
        'must advance within bytes',
      );
    }
    offset += result.bytesWritten;
  }
}

export async function acquireAtomicLock(
  target: AtomicTarget,
  beforePublish: (path: string) => void | Promise<void>,
  beforeMove: (path: string) => void | Promise<void>,
): Promise<AtomicLock> {
  const path = atomicLockPath(target);
  const owner = atomicLockOwner();
  const rawOwner = serializeAtomicLockOwner(owner);
  const candidatePath = atomicLockCandidatePath(path, owner);
  while (true) {
    await assertAtomicDirectoryIdentity(target);
    let handle: AtomicFileHandle;
    try {
      handle = await open(
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
      await handle.chmod(SECURE_FILE_MODE);
      await writeAtomicLockOwner(handle, rawOwner);
      await handle.sync();
      await handle.close();
      await assertAtomicDirectoryIdentity(target);
      try {
        await beforePublish(path);
        await assertAtomicDirectoryIdentity(target);
        await link(candidatePath, path);
      } catch (err) {
        if (!isAlreadyExists(err)) throw err;
        await removeTemporaryFile(candidatePath, target);
        const observed = await observeAtomicLock(target, path);
        if (observed === null) continue;
        if (observed.owner === null) {
          throw fsError.invalidId('atomic lock', path, 'owner identity is not valid');
        }
        if (atomicLockOwnerState(observed.owner) === 'dead') {
          if (
            await removeAtomicLockOwner(target, path, observed.rawOwner, observed.owner, beforeMove)
          )
            continue;
        }
        await new Promise<void>((resolvePromise) =>
          setTimeout(resolvePromise, ATOMIC_LOCK_RETRY_MS),
        );
        continue;
      }
      await assertAtomicDirectoryIdentity(target);
      await removeTemporaryFile(candidatePath, target);
      return { path, rawOwner, owner };
    } catch (err) {
      try {
        await handle.close();
      } catch {
        // Continue to remove the unpublished candidate after a preparation failure.
      }
      await removeTemporaryFile(candidatePath, target);
      throw err;
    }
  }
}

export async function releaseAtomicLock(
  target: AtomicTarget,
  lock: AtomicLock,
  beforeMove: (path: string) => void | Promise<void>,
): Promise<void> {
  let beforeMoveFailed = false;
  let beforeMoveError: unknown;
  const guardedBeforeMove = async (path: string): Promise<void> => {
    try {
      await beforeMove(path);
    } catch (cause) {
      beforeMoveFailed = true;
      beforeMoveError = cause;
      throw cause;
    }
  };
  try {
    await removeAtomicLockOwner(target, lock.path, lock.rawOwner, lock.owner, guardedBeforeMove);
  } catch {
    if (beforeMoveFailed) throw beforeMoveError;
    // A release failure must not replace the write result or unlink a successor.
  }
}
