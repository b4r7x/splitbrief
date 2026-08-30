import {
  constants,
  closeSync,
  readFileSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  linkSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { link, lstat, open, realpath, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fsError, SECURE_FILE_MODE } from './fs.js';
import { isENOENT, isNodeError } from './process/errors.js';
import { readProcessStartTimeMs } from './process/start-time.js';

export type ConfigRevision = Readonly<{
  rawSha256: string;
  fileIdentity: Readonly<{
    dev: bigint;
    ino: bigint;
    size: bigint;
    mtimeNs: bigint;
  }>;
}>;

export type ExpectedConfigRevision = ConfigRevision | null;

export type ConfinedAtomicWriteResult =
  | Readonly<{ kind: 'written'; revision: ConfigRevision }>
  | Readonly<{ kind: 'conflict'; observedRevision: ConfigRevision | null }>
  | Readonly<{ kind: 'durability-uncertain'; observedRevision: ConfigRevision }>;

export type ConfinedAtomicWriteOptions = Readonly<{
  expectedRevision: ExpectedConfigRevision;
  mode: typeof SECURE_FILE_MODE;
}>;

type AtomicFileHandle = Awaited<ReturnType<typeof open>>;
type AtomicSyncFileHandle = number;

type AtomicFileStat = Readonly<{
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  mode: bigint;
  isFile: () => boolean;
}>;

type AtomicDirectoryIdentity = Readonly<{
  dev: bigint;
  ino: bigint;
}>;

type AtomicTarget = Readonly<{
  path: string;
  directory: string;
  directoryIdentity: AtomicDirectoryIdentity;
}>;

type AtomicWriteSyncTarget = 'file' | 'directory';
type AtomicWriteStatTarget = 'temporary' | 'target';

type AtomicLockOwner = Readonly<{
  pid: number;
  startTimeMs: number;
  token: string;
}>;

type AtomicLock = Readonly<{
  path: string;
  rawOwner: string;
  owner: AtomicLockOwner;
}>;

type AtomicSyncLock = Readonly<{
  path: string;
  rawOwner: string;
  owner: AtomicLockOwner;
}>;

type AtomicLockObservation = Readonly<{
  rawOwner: string;
  owner: AtomicLockOwner | null;
}>;

const ATOMIC_LOCK_SUFFIX = '.cas.lock';
const ATOMIC_LOCK_RETRY_MS = 5;
const PROCESS_START_TOLERANCE_MS = 2000;

const CURRENT_PROCESS_START_TIME_MS = Math.round(
  readProcessStartTimeMs(process.pid) ?? Date.now() - process.uptime() * 1000,
);

export type ConfinedAtomicWriteTestOperations = Readonly<{
  open?: (path: string, flags: number, mode?: number) => Promise<AtomicFileHandle>;
  write?: (
    handle: AtomicFileHandle,
    bytes: Uint8Array,
    offset: number,
    length: number,
    position: number | null,
  ) => Promise<Readonly<{ bytesWritten: number }>>;
  read?: (
    handle: AtomicFileHandle,
    bytes: Uint8Array,
    offset: number,
    length: number,
    position: number | null,
  ) => Promise<Readonly<{ bytesRead: number }>>;
  fsync?: (handle: AtomicFileHandle, target: AtomicWriteSyncTarget) => Promise<void>;
  chmod?: (handle: AtomicFileHandle, mode: number) => Promise<void>;
  stat?: (handle: AtomicFileHandle, target: AtomicWriteStatTarget) => Promise<AtomicFileStat>;
  compare?: (
    expectedRevision: ExpectedConfigRevision,
    observedRevision: ConfigRevision | null,
  ) => void | Promise<void>;
  beforeLockPublish?: (path: string) => void | Promise<void>;
  beforeLockMove?: (path: string) => void | Promise<void>;
  rename?: (from: string, to: string) => Promise<void>;
  link?: (from: string, to: string) => Promise<void>;
}>;

export type ConfinedAtomicWriteSyncTestOperations = Readonly<{
  open?: (path: string, flags: number, mode?: number) => AtomicSyncFileHandle;
  write?: (
    handle: AtomicSyncFileHandle,
    bytes: Uint8Array,
    offset: number,
    length: number,
    position: number | null,
  ) => number;
  read?: (
    handle: AtomicSyncFileHandle,
    bytes: Uint8Array,
    offset: number,
    length: number,
    position: number | null,
  ) => number;
  fsync?: (handle: AtomicSyncFileHandle, target: AtomicWriteSyncTarget) => void;
  chmod?: (handle: AtomicSyncFileHandle, mode: number) => void;
  stat?: (handle: AtomicSyncFileHandle, target: AtomicWriteStatTarget) => AtomicFileStat;
  close?: (handle: AtomicSyncFileHandle) => void;
  compare?: (
    expectedRevision: ExpectedConfigRevision,
    observedRevision: ConfigRevision | null,
  ) => void;
  beforeLockPublish?: (path: string) => void;
  beforeLockMove?: (path: string) => void;
  rename?: (from: string, to: string) => void;
  link?: (from: string, to: string) => void;
}>;

type AtomicWriteOperations = Required<ConfinedAtomicWriteTestOperations>;
type AtomicWriteSyncOperations = Required<ConfinedAtomicWriteSyncTestOperations>;

type RevisionRead = Readonly<{
  revision: ConfigRevision;
  stat: AtomicFileStat;
}>;

const ATOMIC_READ_CHUNK_BYTES = 64 * 1024;

function atomicWriteOperations(
  injected: ConfinedAtomicWriteTestOperations | undefined,
): AtomicWriteOperations {
  return {
    open: injected?.open ?? ((path, flags, mode) => open(path, flags, mode)),
    write:
      injected?.write ??
      (async (handle, bytes, offset, length, position) => {
        const result = await handle.write(bytes, offset, length, position);
        return { bytesWritten: result.bytesWritten };
      }),
    read:
      injected?.read ??
      (async (handle, bytes, offset, length, position) => {
        const result = await handle.read(bytes, offset, length, position);
        return { bytesRead: result.bytesRead };
      }),
    fsync: injected?.fsync ?? (async (handle) => handle.sync()),
    chmod: injected?.chmod ?? (async (handle, mode) => handle.chmod(mode)),
    stat: injected?.stat ?? (async (handle) => handle.stat({ bigint: true })),
    compare: injected?.compare ?? (async () => undefined),
    beforeLockPublish: injected?.beforeLockPublish ?? (async () => undefined),
    beforeLockMove: injected?.beforeLockMove ?? (async () => undefined),
    rename: injected?.rename ?? rename,
    link: injected?.link ?? link,
  };
}

function atomicWriteSyncOperations(
  injected: ConfinedAtomicWriteSyncTestOperations | undefined,
): AtomicWriteSyncOperations {
  return {
    open:
      injected?.open ??
      ((path, flags, mode) =>
        mode === undefined ? openSync(path, flags) : openSync(path, flags, mode)),
    write:
      injected?.write ??
      ((handle, bytes, offset, length, position) =>
        writeSync(handle, bytes, offset, length, position)),
    read:
      injected?.read ??
      ((handle, bytes, offset, length, position) =>
        readSync(handle, bytes, offset, length, position)),
    fsync: injected?.fsync ?? ((handle) => fsyncSync(handle)),
    chmod: injected?.chmod ?? ((handle, mode) => fchmodSync(handle, mode)),
    stat: injected?.stat ?? ((handle) => fstatSync(handle, { bigint: true })),
    close: injected?.close ?? closeSync,
    compare: injected?.compare ?? (() => undefined),
    beforeLockPublish: injected?.beforeLockPublish ?? (() => undefined),
    beforeLockMove: injected?.beforeLockMove ?? (() => undefined),
    rename: injected?.rename ?? renameSync,
    link: injected?.link ?? linkSync,
  };
}

function revisionFromStat(rawSha256: string, stat: AtomicFileStat): ConfigRevision {
  return {
    rawSha256,
    fileIdentity: {
      dev: stat.dev,
      ino: stat.ino,
      size: stat.size,
      mtimeNs: stat.mtimeNs,
    },
  };
}

function revisionsMatch(left: ConfigRevision, right: ConfigRevision): boolean {
  return (
    left.rawSha256 === right.rawSha256 &&
    left.fileIdentity.dev === right.fileIdentity.dev &&
    left.fileIdentity.ino === right.fileIdentity.ino &&
    left.fileIdentity.size === right.fileIdentity.size &&
    left.fileIdentity.mtimeNs === right.fileIdentity.mtimeNs
  );
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function assertAtomicMode(mode: number): asserts mode is typeof SECURE_FILE_MODE {
  if (mode !== SECURE_FILE_MODE) {
    throw fsError.invalidId('atomic file mode', mode.toString(8), 'must be owner-only (0600)');
  }
}

function assertRegularFile(path: string, stat: AtomicFileStat): void {
  if (!stat.isFile()) {
    throw fsError.invalidId('atomic target', path, 'must be a regular file');
  }
}

function assertRegularOwnerOnly(path: string, stat: AtomicFileStat): void {
  assertRegularFile(path, stat);
  if ((stat.mode & 0o077n) !== 0n) {
    throw fsError.invalidId('atomic target', path, 'must be a regular owner-only file');
  }
}

function isNoFollowFailure(err: unknown): boolean {
  return isNodeError(err) && err.code === 'ELOOP';
}

function isAlreadyExists(err: unknown): boolean {
  return isNodeError(err) && err.code === 'EEXIST';
}

function atomicLockPath(target: AtomicTarget): string {
  return join(target.directory, `.${basename(target.path)}${ATOMIC_LOCK_SUFFIX}`);
}

function atomicLockOwner(): AtomicLockOwner {
  return {
    pid: process.pid,
    startTimeMs: CURRENT_PROCESS_START_TIME_MS,
    token: randomBytes(16).toString('hex'),
  };
}

function serializeAtomicLockOwner(owner: AtomicLockOwner): string {
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

function atomicLockOwnerState(owner: AtomicLockOwner): 'live' | 'dead' | 'unknown' {
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

async function observeAtomicLock(
  target: AtomicTarget,
  path: string,
): Promise<AtomicLockObservation | null> {
  await assertAtomicDirectoryIdentity(target);
  const observed = await readAtomicLockFile(path);
  if (observed === null) return null;
  await assertAtomicDirectoryIdentity(target);
  return { rawOwner: observed.rawOwner, owner: parseAtomicLockOwner(observed.rawOwner) };
}

async function readAtomicLockFile(path: string): Promise<Readonly<{ rawOwner: string }> | null> {
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

function observeAtomicLockSync(target: AtomicTarget, path: string): AtomicLockObservation | null {
  assertAtomicDirectoryIdentitySync(target);
  const observed = readAtomicLockFileSync(path);
  if (observed === null) return null;
  assertAtomicDirectoryIdentitySync(target);
  return { rawOwner: observed.rawOwner, owner: parseAtomicLockOwner(observed.rawOwner) };
}

function readAtomicLockFileSync(path: string): Readonly<{ rawOwner: string }> | null {
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

function atomicLockSidecar(path: string): string {
  return `${path}.reclaim.${process.pid}.${randomBytes(16).toString('hex')}`;
}

function atomicLockCandidatePath(path: string, owner: AtomicLockOwner): string {
  return `${path}.owner.${owner.pid}.${owner.token}`;
}

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

async function removeAtomicLockOwner(
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

function removeAtomicLockOwnerSync(
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

async function acquireAtomicLock(
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

function acquireAtomicLockSync(
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

async function releaseAtomicLock(
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

function releaseAtomicLockSync(
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

function isDirectorySyncUnsupported(err: unknown): boolean {
  return (
    isNodeError(err) &&
    (err.code === 'EINVAL' || err.code === 'ENOTSUP' || err.code === 'EOPNOTSUPP')
  );
}

function directoryIdentityMatches(
  left: AtomicDirectoryIdentity,
  right: AtomicDirectoryIdentity,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

const DARWIN_PATH_ALIASES = [
  ['/etc', '/private/etc'],
  ['/tmp', '/private/tmp'],
  ['/var', '/private/var'],
] as const;

function isAllowedAtomicPathAlias(path: string, realPath: string): boolean {
  if (path === realPath) return true;
  if (process.platform !== 'darwin') return false;
  return DARWIN_PATH_ALIASES.some(([alias, canonical]) => {
    return (
      (path === alias && realPath === canonical) ||
      (path.startsWith(`${alias}/`) &&
        realPath.startsWith(`${canonical}/`) &&
        realPath.slice(canonical.length) === path.slice(alias.length))
    );
  });
}

function isAllowedAtomicAliasComponent(path: string, realPath: string): boolean {
  if (process.platform !== 'darwin') return false;
  return DARWIN_PATH_ALIASES.some(([alias, canonical]) => path === alias && realPath === canonical);
}

async function assertAtomicDirectoryNoFollow(
  directory: string,
  realDirectory: string,
): Promise<void> {
  let current = resolve(directory);
  while (true) {
    const stat = await lstat(current);
    if (stat.isSymbolicLink()) {
      const realCurrent = await realpath(current);
      if (!isAllowedAtomicAliasComponent(current, realCurrent)) {
        throw fsError.symlinkWrite(current);
      }
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  if (!isAllowedAtomicPathAlias(resolve(directory), realDirectory)) {
    throw fsError.symlinkWrite(directory);
  }
}

async function atomicDirectoryIdentity(directory: string): Promise<AtomicDirectoryIdentity> {
  const realDirectory = await realpath(directory);
  if (realDirectory !== directory) throw fsError.symlinkWrite(directory);
  const stat = await lstat(directory, { bigint: true });
  if (!stat.isDirectory()) {
    throw fsError.invalidId('atomic parent directory', directory, 'must be a real directory');
  }
  return { dev: stat.dev, ino: stat.ino };
}

async function canonicalAtomicTarget(path: string): Promise<AtomicTarget> {
  const target = resolve(path);
  // Resolve the parent once so platform aliases such as macOS `/var` ->
  // `/private/var` do not look like a symlink write. The identity captured here
  // still fences the directory against replacement during the operation.
  const requestedDirectory = dirname(target);
  const directory = await realpath(requestedDirectory);
  await assertAtomicDirectoryNoFollow(requestedDirectory, directory);
  return {
    path: join(directory, basename(target)),
    directory,
    directoryIdentity: await atomicDirectoryIdentity(directory),
  };
}

async function assertAtomicDirectoryIdentity(target: AtomicTarget): Promise<void> {
  let current: AtomicDirectoryIdentity;
  try {
    current = await atomicDirectoryIdentity(target.directory);
  } catch (err) {
    if (isENOENT(err)) {
      throw fsError.invalidId(
        'atomic parent directory',
        target.directory,
        'changed during replacement',
      );
    }
    throw err;
  }
  if (!directoryIdentityMatches(target.directoryIdentity, current)) {
    throw fsError.invalidId(
      'atomic parent directory',
      target.directory,
      'changed during replacement',
    );
  }
}

async function assertAtomicTargetIsNotSymlink(target: AtomicTarget): Promise<void> {
  await assertAtomicDirectoryIdentity(target);
  try {
    if ((await lstat(target.path)).isSymbolicLink()) throw fsError.symlinkWrite(target.path);
  } catch (err) {
    if (fsError.isSymlinkWrite(err)) throw err;
    if (!isENOENT(err)) throw err;
  }
}

async function readRevision(
  handle: AtomicFileHandle,
  operations: AtomicWriteOperations,
  statTarget: AtomicWriteStatTarget,
): Promise<RevisionRead> {
  const digest = createHash('sha256');
  const chunk = Buffer.allocUnsafe(ATOMIC_READ_CHUNK_BYTES);
  let position = 0;

  while (true) {
    const { bytesRead } = await operations.read(handle, chunk, 0, chunk.byteLength, position);
    if (bytesRead === 0) break;
    if (bytesRead < 0 || bytesRead > chunk.byteLength) {
      throw fsError.invalidId(
        'atomic read length',
        String(bytesRead),
        'must be within the read buffer',
      );
    }
    digest.update(chunk.subarray(0, bytesRead));
    position += bytesRead;
  }

  const stat = await operations.stat(handle, statTarget);
  return { revision: revisionFromStat(digest.digest('hex'), stat), stat };
}

async function readTargetRevision(
  target: AtomicTarget,
  operations: AtomicWriteOperations,
  requireOwnerOnly: boolean,
): Promise<RevisionRead | null> {
  await assertAtomicDirectoryIdentity(target);
  let handle: AtomicFileHandle;
  try {
    handle = await operations.open(target.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (err) {
    if (isENOENT(err)) return null;
    if (isNoFollowFailure(err)) throw fsError.symlinkWrite(target.path);
    throw err;
  }

  try {
    const read = await readRevision(handle, operations, 'target');
    assertRegularFile(target.path, read.stat);
    if (requireOwnerOnly) assertRegularOwnerOnly(target.path, read.stat);
    return read;
  } finally {
    await handle.close();
  }
}

async function writeAll(
  handle: AtomicFileHandle,
  bytes: Uint8Array,
  operations: AtomicWriteOperations,
): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const remaining = bytes.byteLength - offset;
    const { bytesWritten } = await operations.write(handle, bytes, offset, remaining, offset);
    if (bytesWritten <= 0 || bytesWritten > remaining) {
      throw fsError.invalidId(
        'atomic write length',
        String(bytesWritten),
        'must advance within bytes',
      );
    }
    offset += bytesWritten;
  }
}

async function removeTemporaryFile(path: string, target?: AtomicTarget): Promise<void> {
  if (target !== undefined) {
    try {
      await assertAtomicDirectoryIdentity(target);
    } catch (err) {
      if (fsError.isInvalidId(err) || fsError.isSymlinkWrite(err) || isENOENT(err)) return;
      throw err;
    }
  }
  try {
    await unlink(path);
  } catch (err) {
    if (!isENOENT(err)) throw err;
  }
}

async function syncDirectory(
  target: AtomicTarget,
  operations: AtomicWriteOperations,
): Promise<void> {
  await assertAtomicDirectoryIdentity(target);
  let directory: AtomicFileHandle;
  try {
    directory = await operations.open(
      target.directory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
  } catch (err) {
    if (isDirectorySyncUnsupported(err)) return;
    throw err;
  }

  try {
    await operations.fsync(directory, 'directory');
  } catch (err) {
    if (isDirectorySyncUnsupported(err)) return;
    throw err;
  } finally {
    await directory.close();
  }
}

function temporaryPath(target: AtomicTarget): string {
  return join(target.directory, `.${basename(target.path)}.tmp.${randomBytes(16).toString('hex')}`);
}

async function confinedAtomicWriteFileWithOperations(
  path: string,
  sourceBytes: Uint8Array,
  options: ConfinedAtomicWriteOptions,
  operations: AtomicWriteOperations,
): Promise<ConfinedAtomicWriteResult> {
  assertAtomicMode(options.mode);
  const bytes = Buffer.from(sourceBytes);
  const target = await canonicalAtomicTarget(path);
  await assertAtomicTargetIsNotSymlink(target);
  const lock = await acquireAtomicLock(
    target,
    operations.beforeLockPublish,
    operations.beforeLockMove,
  );

  let tempPath: string | null = null;
  let renamed = false;
  let replacementRevision: ConfigRevision | null = null;
  let observedRevision: ConfigRevision | null = null;

  try {
    try {
      await assertAtomicDirectoryIdentity(target);
      tempPath = temporaryPath(target);
      const temporary = await operations.open(
        tempPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        options.mode,
      );

      try {
        await operations.chmod(temporary, options.mode);
        await writeAll(temporary, bytes, operations);
        await operations.fsync(temporary, 'file');
        const temporaryStat = await operations.stat(temporary, 'temporary');
        assertRegularOwnerOnly(tempPath, temporaryStat);
        replacementRevision = revisionFromStat(sha256(bytes), temporaryStat);
      } finally {
        await temporary.close();
      }

      const current = await readTargetRevision(target, operations, false);
      await operations.compare(options.expectedRevision, current?.revision ?? null);
      const expectedMatches =
        options.expectedRevision === null
          ? current === null
          : current !== null && revisionsMatch(options.expectedRevision, current.revision);
      if (!expectedMatches) {
        await removeTemporaryFile(tempPath, target);
        tempPath = null;
        return { kind: 'conflict', observedRevision: current?.revision ?? null };
      }

      if (replacementRevision === null) {
        throw fsError.invalidId(
          'atomic replacement revision',
          'missing',
          'must be recorded before rename',
        );
      }
      const plannedRevision = replacementRevision;
      await assertAtomicDirectoryIdentity(target);
      if (options.expectedRevision === null) {
        try {
          await operations.link(tempPath, target.path);
        } catch (err) {
          if (!isAlreadyExists(err)) throw err;
          const raced = await readTargetRevision(target, operations, false);
          await removeTemporaryFile(tempPath, target);
          tempPath = null;
          return { kind: 'conflict', observedRevision: raced?.revision ?? null };
        }
        renamed = true;
        await removeTemporaryFile(tempPath, target);
      } else {
        await operations.rename(tempPath, target.path);
        renamed = true;
      }
      tempPath = null;

      const final = await readTargetRevision(target, operations, true);
      if (final !== null) observedRevision = final.revision;
      await syncDirectory(target, operations);

      if (observedRevision === null || !revisionsMatch(plannedRevision, observedRevision)) {
        return {
          kind: 'durability-uncertain',
          observedRevision: observedRevision ?? plannedRevision,
        };
      }
      return { kind: 'written', revision: observedRevision };
    } catch (err) {
      if (renamed && replacementRevision !== null) {
        return {
          kind: 'durability-uncertain',
          observedRevision: observedRevision ?? replacementRevision,
        };
      }
      if (tempPath !== null) await removeTemporaryFile(tempPath, target);
      await assertAtomicDirectoryIdentity(target);
      throw err;
    }
  } finally {
    await releaseAtomicLock(target, lock, operations.beforeLockMove);
  }
}

export async function confinedAtomicWriteFile(
  path: string,
  bytes: Uint8Array,
  options: ConfinedAtomicWriteOptions,
): Promise<ConfinedAtomicWriteResult> {
  return confinedAtomicWriteFileWithOperations(
    path,
    bytes,
    options,
    atomicWriteOperations(undefined),
  );
}

export async function confinedAtomicWriteFileForTest(
  path: string,
  bytes: Uint8Array,
  options: ConfinedAtomicWriteOptions,
  operations: ConfinedAtomicWriteTestOperations,
): Promise<ConfinedAtomicWriteResult> {
  return confinedAtomicWriteFileWithOperations(
    path,
    bytes,
    options,
    atomicWriteOperations(operations),
  );
}

function atomicDirectoryIdentitySync(directory: string): AtomicDirectoryIdentity {
  const realDirectory = realpathSync(directory);
  if (realDirectory !== directory) throw fsError.symlinkWrite(directory);
  const stat = lstatSync(directory, { bigint: true });
  if (!stat.isDirectory()) {
    throw fsError.invalidId('atomic parent directory', directory, 'must be a real directory');
  }
  return { dev: stat.dev, ino: stat.ino };
}

function assertAtomicDirectoryNoFollowSync(directory: string, realDirectory: string): void {
  let current = resolve(directory);
  while (true) {
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) {
      const realCurrent = realpathSync(current);
      if (!isAllowedAtomicAliasComponent(current, realCurrent)) {
        throw fsError.symlinkWrite(current);
      }
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  if (!isAllowedAtomicPathAlias(resolve(directory), realDirectory)) {
    throw fsError.symlinkWrite(directory);
  }
}

function canonicalAtomicTargetSync(path: string): AtomicTarget {
  const target = resolve(path);
  // Resolve the parent once so platform aliases such as macOS `/var` ->
  // `/private/var` do not look like a symlink write. The identity captured here
  // still fences the directory against replacement during the operation.
  const requestedDirectory = dirname(target);
  const directory = realpathSync(requestedDirectory);
  assertAtomicDirectoryNoFollowSync(requestedDirectory, directory);
  return {
    path: join(directory, basename(target)),
    directory,
    directoryIdentity: atomicDirectoryIdentitySync(directory),
  };
}

function assertAtomicDirectoryIdentitySync(target: AtomicTarget): void {
  let current: AtomicDirectoryIdentity;
  try {
    current = atomicDirectoryIdentitySync(target.directory);
  } catch (err) {
    if (isENOENT(err)) {
      throw fsError.invalidId(
        'atomic parent directory',
        target.directory,
        'changed during replacement',
      );
    }
    throw err;
  }
  if (!directoryIdentityMatches(target.directoryIdentity, current)) {
    throw fsError.invalidId(
      'atomic parent directory',
      target.directory,
      'changed during replacement',
    );
  }
}

function assertAtomicTargetIsNotSymlinkSync(target: AtomicTarget): void {
  assertAtomicDirectoryIdentitySync(target);
  try {
    if (lstatSync(target.path).isSymbolicLink()) throw fsError.symlinkWrite(target.path);
  } catch (err) {
    if (fsError.isSymlinkWrite(err)) throw err;
    if (!isENOENT(err)) throw err;
  }
}

function readRevisionSync(
  handle: AtomicSyncFileHandle,
  operations: AtomicWriteSyncOperations,
  statTarget: AtomicWriteStatTarget,
): RevisionRead {
  const digest = createHash('sha256');
  const chunk = Buffer.allocUnsafe(ATOMIC_READ_CHUNK_BYTES);
  let position = 0;

  while (true) {
    const bytesRead = operations.read(handle, chunk, 0, chunk.byteLength, position);
    if (bytesRead === 0) break;
    if (bytesRead < 0 || bytesRead > chunk.byteLength) {
      throw fsError.invalidId(
        'atomic read length',
        String(bytesRead),
        'must be within the read buffer',
      );
    }
    digest.update(chunk.subarray(0, bytesRead));
    position += bytesRead;
  }

  const stat = operations.stat(handle, statTarget);
  return { revision: revisionFromStat(digest.digest('hex'), stat), stat };
}

function readTargetRevisionSync(
  target: AtomicTarget,
  operations: AtomicWriteSyncOperations,
  requireOwnerOnly: boolean,
): RevisionRead | null {
  assertAtomicDirectoryIdentitySync(target);
  let handle: AtomicSyncFileHandle;
  try {
    handle = operations.open(target.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (err) {
    if (isENOENT(err)) return null;
    if (isNoFollowFailure(err)) throw fsError.symlinkWrite(target.path);
    throw err;
  }

  try {
    const read = readRevisionSync(handle, operations, 'target');
    assertRegularFile(target.path, read.stat);
    if (requireOwnerOnly) assertRegularOwnerOnly(target.path, read.stat);
    return read;
  } finally {
    operations.close(handle);
  }
}

function writeAllSync(
  handle: AtomicSyncFileHandle,
  bytes: Uint8Array,
  operations: AtomicWriteSyncOperations,
): void {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const remaining = bytes.byteLength - offset;
    const bytesWritten = operations.write(handle, bytes, offset, remaining, offset);
    if (bytesWritten <= 0 || bytesWritten > remaining) {
      throw fsError.invalidId(
        'atomic write length',
        String(bytesWritten),
        'must advance within bytes',
      );
    }
    offset += bytesWritten;
  }
}

function removeTemporaryFileSync(path: string, target?: AtomicTarget): void {
  if (target !== undefined) {
    try {
      assertAtomicDirectoryIdentitySync(target);
    } catch (err) {
      if (fsError.isInvalidId(err) || fsError.isSymlinkWrite(err) || isENOENT(err)) return;
      throw err;
    }
  }
  try {
    unlinkSync(path);
  } catch (err) {
    if (!isENOENT(err)) throw err;
  }
}

function syncDirectorySync(target: AtomicTarget, operations: AtomicWriteSyncOperations): void {
  assertAtomicDirectoryIdentitySync(target);
  let directory: AtomicSyncFileHandle;
  try {
    directory = operations.open(
      target.directory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
  } catch (err) {
    if (isDirectorySyncUnsupported(err)) return;
    throw err;
  }

  try {
    operations.fsync(directory, 'directory');
  } catch (err) {
    if (isDirectorySyncUnsupported(err)) return;
    throw err;
  } finally {
    operations.close(directory);
  }
}

function confinedAtomicWriteFileSyncWithOperations(
  path: string,
  sourceBytes: Uint8Array,
  options: ConfinedAtomicWriteOptions,
  operations: AtomicWriteSyncOperations,
): ConfinedAtomicWriteResult {
  assertAtomicMode(options.mode);
  const bytes = Buffer.from(sourceBytes);
  const target = canonicalAtomicTargetSync(path);
  assertAtomicTargetIsNotSymlinkSync(target);
  const lock = acquireAtomicLockSync(
    target,
    operations.beforeLockPublish,
    operations.beforeLockMove,
  );

  let tempPath: string | null = null;
  let renamed = false;
  let replacementRevision: ConfigRevision | null = null;
  let observedRevision: ConfigRevision | null = null;

  try {
    try {
      assertAtomicDirectoryIdentitySync(target);
      tempPath = temporaryPath(target);
      const temporary = operations.open(
        tempPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        options.mode,
      );

      try {
        operations.chmod(temporary, options.mode);
        writeAllSync(temporary, bytes, operations);
        operations.fsync(temporary, 'file');
        const temporaryStat = operations.stat(temporary, 'temporary');
        assertRegularOwnerOnly(tempPath, temporaryStat);
        replacementRevision = revisionFromStat(sha256(bytes), temporaryStat);
      } finally {
        operations.close(temporary);
      }

      const current = readTargetRevisionSync(target, operations, false);
      operations.compare(options.expectedRevision, current?.revision ?? null);
      const expectedMatches =
        options.expectedRevision === null
          ? current === null
          : current !== null && revisionsMatch(options.expectedRevision, current.revision);
      if (!expectedMatches) {
        removeTemporaryFileSync(tempPath, target);
        tempPath = null;
        return { kind: 'conflict', observedRevision: current?.revision ?? null };
      }

      if (replacementRevision === null) {
        throw fsError.invalidId(
          'atomic replacement revision',
          'missing',
          'must be recorded before rename',
        );
      }
      const plannedRevision = replacementRevision;
      assertAtomicDirectoryIdentitySync(target);
      if (options.expectedRevision === null) {
        try {
          operations.link(tempPath, target.path);
        } catch (err) {
          if (!isAlreadyExists(err)) throw err;
          const raced = readTargetRevisionSync(target, operations, false);
          removeTemporaryFileSync(tempPath, target);
          tempPath = null;
          return { kind: 'conflict', observedRevision: raced?.revision ?? null };
        }
        renamed = true;
        removeTemporaryFileSync(tempPath, target);
      } else {
        operations.rename(tempPath, target.path);
        renamed = true;
      }
      tempPath = null;

      const final = readTargetRevisionSync(target, operations, true);
      if (final !== null) observedRevision = final.revision;
      syncDirectorySync(target, operations);

      if (observedRevision === null || !revisionsMatch(plannedRevision, observedRevision)) {
        return {
          kind: 'durability-uncertain',
          observedRevision: observedRevision ?? plannedRevision,
        };
      }
      return { kind: 'written', revision: observedRevision };
    } catch (err) {
      if (renamed && replacementRevision !== null) {
        return {
          kind: 'durability-uncertain',
          observedRevision: observedRevision ?? replacementRevision,
        };
      }
      if (tempPath !== null) removeTemporaryFileSync(tempPath, target);
      assertAtomicDirectoryIdentitySync(target);
      throw err;
    }
  } finally {
    releaseAtomicLockSync(target, lock, operations.beforeLockMove);
  }
}

export function confinedAtomicWriteFileSync(
  path: string,
  bytes: Uint8Array,
  options: ConfinedAtomicWriteOptions,
): ConfinedAtomicWriteResult {
  return confinedAtomicWriteFileSyncWithOperations(
    path,
    bytes,
    options,
    atomicWriteSyncOperations(undefined),
  );
}

export function confinedAtomicWriteFileSyncForTest(
  path: string,
  bytes: Uint8Array,
  options: ConfinedAtomicWriteOptions,
  operations: ConfinedAtomicWriteSyncTestOperations,
): ConfinedAtomicWriteResult {
  return confinedAtomicWriteFileSyncWithOperations(
    path,
    bytes,
    options,
    atomicWriteSyncOperations(operations),
  );
}
