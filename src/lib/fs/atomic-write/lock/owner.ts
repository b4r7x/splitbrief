import { constants, closeSync, readFileSync, fstatSync, openSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { open } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { isNodeError, isENOENT } from '../../../../utils/errno.js';
import { readProcessStartTimeMs } from '../../../process/start-time.js';
import { fsError } from '../../secure.js';
import {
  assertAtomicDirectoryIdentity,
  isNoFollowFailure,
  assertAtomicDirectoryIdentitySync,
} from '../target.js';
import type {
  AtomicTarget,
  AtomicLockOwner,
  AtomicLockObservation,
  AtomicFileHandle,
  AtomicSyncFileHandle,
} from '../types.js';

const ATOMIC_LOCK_SUFFIX = '.cas.lock';
export const ATOMIC_LOCK_RETRY_MS = 5;
const PROCESS_START_TOLERANCE_MS = 2000;

const CURRENT_PROCESS_START_TIME_MS = Math.round(
  readProcessStartTimeMs(process.pid) ?? Date.now() - process.uptime() * 1000,
);

export function atomicLockPath(target: AtomicTarget): string {
  return join(target.directory, `.${basename(target.path)}${ATOMIC_LOCK_SUFFIX}`);
}

export function atomicLockOwner(): AtomicLockOwner {
  return {
    pid: process.pid,
    startTimeMs: CURRENT_PROCESS_START_TIME_MS,
    token: randomBytes(16).toString('hex'),
  };
}

export function serializeAtomicLockOwner(owner: AtomicLockOwner): string {
  return JSON.stringify(owner);
}

function parseAtomicLockOwner(rawOwner: string): AtomicLockOwner | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawOwner);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  if (!('pid' in parsed) || !('startTimeMs' in parsed) || !('token' in parsed)) return null;
  if (
    typeof parsed.pid !== 'number' ||
    !Number.isInteger(parsed.pid) ||
    parsed.pid <= 0 ||
    typeof parsed.startTimeMs !== 'number' ||
    !Number.isInteger(parsed.startTimeMs) ||
    parsed.startTimeMs < 0 ||
    typeof parsed.token !== 'string' ||
    !/^[0-9a-f]{32}$/u.test(parsed.token)
  ) {
    return null;
  }
  return { pid: parsed.pid, startTimeMs: parsed.startTimeMs, token: parsed.token };
}

export function atomicLockOwnerState(owner: AtomicLockOwner): 'live' | 'dead' | 'unknown' {
  const observedStartTimeMs =
    owner.pid === process.pid ? CURRENT_PROCESS_START_TIME_MS : readProcessStartTimeMs(owner.pid);
  if (observedStartTimeMs !== null) {
    return Math.abs(observedStartTimeMs - owner.startTimeMs) <= PROCESS_START_TOLERANCE_MS
      ? 'live'
      : 'dead';
  }
  try {
    process.kill(owner.pid, 0);
    return 'unknown';
  } catch (err) {
    return isNodeError(err) && err.code === 'ESRCH' ? 'dead' : 'unknown';
  }
}

function assertAtomicLockStat(
  path: string,
  stat: Readonly<{
    mode: bigint;
    isFile: () => boolean;
    isSymbolicLink: () => boolean;
  }>,
): void {
  if (stat.isSymbolicLink()) throw fsError.symlinkWrite(path);
  if (!stat.isFile()) {
    throw fsError.invalidId('atomic lock', path, 'must be a regular file');
  }
  if ((stat.mode & 0o077n) !== 0n) {
    throw fsError.invalidId('atomic lock', path, 'must be a regular owner-only file');
  }
}

export async function observeAtomicLock(
  target: AtomicTarget,
  path: string,
): Promise<AtomicLockObservation | null> {
  await assertAtomicDirectoryIdentity(target);
  const observed = await readAtomicLockFile(path);
  if (observed === null) return null;
  await assertAtomicDirectoryIdentity(target);
  return { rawOwner: observed.rawOwner, owner: parseAtomicLockOwner(observed.rawOwner) };
}

export async function readAtomicLockFile(
  path: string,
): Promise<Readonly<{ rawOwner: string }> | null> {
  let handle: AtomicFileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (err) {
    if (isENOENT(err)) return null;
    if (isNoFollowFailure(err)) throw fsError.symlinkWrite(path);
    throw err;
  }

  try {
    const stat = await handle.stat({ bigint: true });
    assertAtomicLockStat(path, stat);
    return { rawOwner: await handle.readFile('utf8') };
  } finally {
    await handle.close();
  }
}

export function observeAtomicLockSync(
  target: AtomicTarget,
  path: string,
): AtomicLockObservation | null {
  assertAtomicDirectoryIdentitySync(target);
  const observed = readAtomicLockFileSync(path);
  if (observed === null) return null;
  assertAtomicDirectoryIdentitySync(target);
  return { rawOwner: observed.rawOwner, owner: parseAtomicLockOwner(observed.rawOwner) };
}

export function readAtomicLockFileSync(path: string): Readonly<{ rawOwner: string }> | null {
  let handle: AtomicSyncFileHandle;
  try {
    handle = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (err) {
    if (isENOENT(err)) return null;
    if (isNoFollowFailure(err)) throw fsError.symlinkWrite(path);
    throw err;
  }

  try {
    const stat = fstatSync(handle, { bigint: true });
    assertAtomicLockStat(path, stat);
    return { rawOwner: readFileSync(handle, 'utf8') };
  } finally {
    closeSync(handle);
  }
}

export function atomicLockSidecar(path: string): string {
  return `${path}.reclaim.${process.pid}.${randomBytes(16).toString('hex')}`;
}

export function atomicLockCandidatePath(path: string, owner: AtomicLockOwner): string {
  return `${path}.owner.${owner.pid}.${owner.token}`;
}
