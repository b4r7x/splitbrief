import { constants } from 'node:fs';
import { releaseAtomicLock } from './lock/acquire.js';
import { acquireAtomicLock } from './lock/acquire.js';
import { fsError, nameWriteTarget } from '../secure.js';
import {
  type AtomicWriteOperations,
  atomicWriteOperations,
  type ConfinedAtomicWriteTestOperations,
} from './operations.js';
import {
  assertAtomicMode,
  assertRegularOwnerOnly,
  revisionFromStat,
  sha256,
  readTargetRevision,
  revisionsMatch,
} from './revision.js';
import {
  assertAtomicDirectoryIdentity,
  isDirectorySyncUnsupported,
  canonicalAtomicTarget,
  assertAtomicTargetIsNotSymlink,
  isAlreadyExists,
} from './target.js';
import { temporaryPath, removeTemporaryFile } from './temporary.js';
import type {
  AtomicFileHandle,
  AtomicTarget,
  ConfinedAtomicWriteOptions,
  ConfinedAtomicWriteResult,
  ConfigRevision,
} from './types.js';

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
  ).catch((err: unknown) => {
    throw nameWriteTarget(err, path);
  });
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
  ).catch((err: unknown) => {
    throw nameWriteTarget(err, path);
  });
}
