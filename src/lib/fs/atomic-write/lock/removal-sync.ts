import { linkSync, renameSync, unlinkSync } from 'node:fs';
import { isENOENT } from '../../../../utils/errno.js';
import { fsError } from '../../secure.js';
import { assertAtomicDirectoryIdentitySync, isAlreadyExists } from '../target.js';
import type { AtomicTarget, AtomicLockOwner } from '../types.js';
import { atomicLockCandidatePath, readAtomicLockFileSync, atomicLockSidecar } from './owner.js';

function removeAtomicLockCandidateSync(
  target: AtomicTarget,
  path: string,
  owner: AtomicLockOwner,
  expectedRawOwner: string,
): void {
  const candidatePath = atomicLockCandidatePath(path, owner);
  try {
    assertAtomicDirectoryIdentitySync(target);
    const observed = readAtomicLockFileSync(candidatePath);
    if (observed === null) return;
    const rawOwner = observed.rawOwner;
    assertAtomicDirectoryIdentitySync(target);
    if (rawOwner === expectedRawOwner) {
      assertAtomicDirectoryIdentitySync(target);
      unlinkSync(candidatePath);
    }
  } catch (err) {
    if (isENOENT(err) || fsError.isSymlinkWrite(err) || fsError.isInvalidId(err)) return;
    throw err;
  }
}

function restoreAtomicLockSidecarSync(
  target: AtomicTarget,
  path: string,
  sidecar: string,
): boolean {
  try {
    assertAtomicDirectoryIdentitySync(target);
  } catch (err) {
    if (fsError.isInvalidId(err) || fsError.isSymlinkWrite(err) || isENOENT(err)) return false;
    throw err;
  }
  let restored = false;
  try {
    linkSync(sidecar, path);
    restored = true;
  } catch (err) {
    if (!isAlreadyExists(err) && !isENOENT(err)) throw err;
  }
  if (restored) {
    try {
      assertAtomicDirectoryIdentitySync(target);
      unlinkSync(sidecar);
    } catch (err) {
      if (!isENOENT(err)) throw err;
    }
  }
  return restored;
}

export function removeAtomicLockOwnerSync(
  target: AtomicTarget,
  path: string,
  expectedRawOwner: string,
  expectedOwner: AtomicLockOwner,
  beforeMove: (path: string) => void,
): boolean {
  try {
    assertAtomicDirectoryIdentitySync(target);
    if (readAtomicLockFileSync(path) === null) return false;
    const sidecar = atomicLockSidecar(path);
    try {
      beforeMove(path);
      assertAtomicDirectoryIdentitySync(target);
      renameSync(path, sidecar);
    } catch (err) {
      if (isENOENT(err)) return false;
      throw err;
    }
    try {
      assertAtomicDirectoryIdentitySync(target);
      const claimed = readAtomicLockFileSync(sidecar)?.rawOwner;
      if (claimed === undefined) return false;
      if (claimed === expectedRawOwner) {
        assertAtomicDirectoryIdentitySync(target);
        unlinkSync(sidecar);
        removeAtomicLockCandidateSync(target, path, expectedOwner, expectedRawOwner);
        return true;
      }
      restoreAtomicLockSidecarSync(target, path, sidecar);
      return false;
    } catch (err) {
      try {
        restoreAtomicLockSidecarSync(target, path, sidecar);
      } catch {
        // Keep the moved lock in place when the canonical parent changed.
      }
      throw err;
    }
  } catch (err) {
    if (isENOENT(err) || fsError.isSymlinkWrite(err) || fsError.isInvalidId(err)) return false;
    throw err;
  }
}
