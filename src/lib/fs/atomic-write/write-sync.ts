import { constants } from 'node:fs';
import { sha256Hex } from '../../../utils/sha256.js';
import { acquireAtomicLockSync, releaseAtomicLockSync } from './lock/acquire-sync.js';
import { fsError, nameWriteTarget } from '../secure.js';
import {
  type AtomicWriteSyncOperations,
  atomicWriteSyncOperations,
  type ConfinedAtomicWriteSyncTestOperations,
} from './operations.js';
import {
  assertAtomicMode,
  assertRegularOwnerOnly,
  revisionFromStat,
  readTargetRevisionSync,
  revisionsMatch,
} from './revision.js';
import {
  assertAtomicDirectoryIdentitySync,
  isDirectorySyncUnsupported,
  canonicalAtomicTargetSync,
  assertAtomicTargetIsNotSymlinkSync,
  isAlreadyExists,
} from './target.js';
import { temporaryPath, removeTemporaryFileSync } from './temporary.js';
import type {
  AtomicSyncFileHandle,
  AtomicTarget,
  ConfinedAtomicWriteOptions,
  ConfinedAtomicWriteResult,
  ConfigRevision,
} from './types.js';

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
        replacementRevision = revisionFromStat(sha256Hex(bytes), temporaryStat);
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
  try {
    return confinedAtomicWriteFileSyncWithOperations(
      path,
      bytes,
      options,
      atomicWriteSyncOperations(undefined),
    );
  } catch (err) {
    throw nameWriteTarget(err, path);
  }
}

export function confinedAtomicWriteFileSyncForTest(
  path: string,
  bytes: Uint8Array,
  options: ConfinedAtomicWriteOptions,
  operations: ConfinedAtomicWriteSyncTestOperations,
): ConfinedAtomicWriteResult {
  try {
    return confinedAtomicWriteFileSyncWithOperations(
      path,
      bytes,
      options,
      atomicWriteSyncOperations(operations),
    );
  } catch (err) {
    throw nameWriteTarget(err, path);
  }
}
