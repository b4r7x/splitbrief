import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { SECURE_FILE_MODE, fsError } from '../secure.js';
import type {
  ConfigRevision,
  AtomicFileStat,
  AtomicFileHandle,
  AtomicTarget,
  AtomicWriteStatTarget,
  AtomicSyncFileHandle,
} from './types.js';
import { isENOENT } from '../../../utils/errno.js';
import { assertAtomicDirectoryIdentitySync } from './target.js';
import { assertAtomicDirectoryIdentity } from './target.js';
import { isNoFollowFailure } from './target.js';
import type { AtomicWriteOperations, AtomicWriteSyncOperations } from './operations.js';

type RevisionRead = Readonly<{
  revision: ConfigRevision;
  stat: AtomicFileStat;
}>;

const ATOMIC_READ_CHUNK_BYTES = 64 * 1024;

export function revisionFromStat(rawSha256: string, stat: AtomicFileStat): ConfigRevision {
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

export function revisionsMatch(left: ConfigRevision, right: ConfigRevision): boolean {
  return (
    left.rawSha256 === right.rawSha256 &&
    left.fileIdentity.dev === right.fileIdentity.dev &&
    left.fileIdentity.ino === right.fileIdentity.ino &&
    left.fileIdentity.size === right.fileIdentity.size &&
    left.fileIdentity.mtimeNs === right.fileIdentity.mtimeNs
  );
}

export function assertAtomicMode(mode: number): asserts mode is typeof SECURE_FILE_MODE {
  if (mode !== SECURE_FILE_MODE) {
    throw fsError.invalidId('atomic file mode', mode.toString(8), 'must be owner-only (0600)');
  }
}

function assertRegularFile(path: string, stat: AtomicFileStat): void {
  if (!stat.isFile()) {
    throw fsError.invalidId('atomic target', path, 'must be a regular file');
  }
}

export function assertRegularOwnerOnly(path: string, stat: AtomicFileStat): void {
  assertRegularFile(path, stat);
  if ((stat.mode & 0o077n) !== 0n) {
    throw fsError.invalidId('atomic target', path, 'must be a regular owner-only file');
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

export async function readTargetRevision(
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

export function readTargetRevisionSync(
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
