import { link, rename, unlink } from 'node:fs/promises';
import { isENOENT } from '../../../../utils/errno.js';
import { fsError } from '../../secure.js';
import { assertAtomicDirectoryIdentity, isAlreadyExists } from '../target.js';
import type { AtomicTarget, AtomicLockOwner } from '../types.js';
import { atomicLockCandidatePath, atomicLockSidecar, readAtomicLockFile } from './owner.js';

async function removeAtomicLockCandidate(
  target: AtomicTarget,
  path: string,
  owner: AtomicLockOwner,
  expectedRawOwner: string,
): Promise<void> {
  const candidatePath = atomicLockCandidatePath(path, owner);
  try {
    await assertAtomicDirectoryIdentity(target);
    const observed = await readAtomicLockFile(candidatePath);
    if (observed === null) return;
    const rawOwner = observed.rawOwner;
    await assertAtomicDirectoryIdentity(target);
    if (rawOwner === expectedRawOwner) {
      await assertAtomicDirectoryIdentity(target);
      await unlink(candidatePath);
    }
  } catch (err) {
    if (isENOENT(err) || fsError.isSymlinkWrite(err) || fsError.isInvalidId(err)) return;
    throw err;
  }
}

async function restoreAtomicLockSidecar(
  target: AtomicTarget,
  path: string,
  sidecar: string,
): Promise<boolean> {
  try {
    await assertAtomicDirectoryIdentity(target);
  } catch (err) {
    if (fsError.isInvalidId(err) || fsError.isSymlinkWrite(err) || isENOENT(err)) return false;
    throw err;
  }
  let restored = false;
  try {
    await link(sidecar, path);
    restored = true;
  } catch (err) {
    if (!isAlreadyExists(err) && !isENOENT(err)) throw err;
  }
  if (restored) {
    try {
      await assertAtomicDirectoryIdentity(target);
      await unlink(sidecar);
    } catch (err) {
      if (!isENOENT(err)) throw err;
    }
  }
  return restored;
}

export async function removeAtomicLockOwner(
  target: AtomicTarget,
  path: string,
  expectedRawOwner: string,
  expectedOwner: AtomicLockOwner,
  beforeMove: (path: string) => void | Promise<void>,
): Promise<boolean> {
  try {
    await assertAtomicDirectoryIdentity(target);
    if ((await readAtomicLockFile(path)) === null) return false;
    const sidecar = atomicLockSidecar(path);
    try {
      await beforeMove(path);
      await assertAtomicDirectoryIdentity(target);
      await rename(path, sidecar);
    } catch (err) {
      if (isENOENT(err)) return false;
      throw err;
    }
    try {
      await assertAtomicDirectoryIdentity(target);
      const claimed = (await readAtomicLockFile(sidecar))?.rawOwner;
      if (claimed === undefined) return false;
      if (claimed === expectedRawOwner) {
        await assertAtomicDirectoryIdentity(target);
        await unlink(sidecar);
        await removeAtomicLockCandidate(target, path, expectedOwner, expectedRawOwner);
        return true;
      }
      await restoreAtomicLockSidecar(target, path, sidecar);
      return false;
    } catch (err) {
      try {
        await restoreAtomicLockSidecar(target, path, sidecar);
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
