import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { SnapshotManifest } from '../../core/schemas/snapshot.js';
import { snapshotFilesDir, SNAPSHOT_BASELINE_ID } from '../../core/paths.js';
import type { EventBus } from '../events/types.js';
import { error } from '../../utils/error.js';
import {
  acquireSnapshotLock,
  hashFile,
  listSnapshotIds,
  readManifest,
} from './store.js';

export type RestoreResult = {
  snapshotId: string;
  restoredPaths: string[];
  conflictedPaths: string[];
  forcedPaths: string[];
  missingSnapshotFiles: string[];
};

export type RestoreOptions = {
  projectDir: string;
  sessionId: string;
  idOrName: string;
  force?: boolean;
  bus?: EventBus;
};

export const snapshotRestoreError = {
  notFound: (idOrName: string) =>
    error('snapshot-not-found', `No snapshot found with id or name: ${idOrName}`, { idOrName }),
  ambiguousName: (idOrName: string, ids: string) =>
    error('snapshot-name-ambiguous', `Ambiguous snapshot name '${idOrName}': matches ${ids}. Use the snapshot ID directly.`, { idOrName, ids }),
  baselineMissing: (sessionId: string) =>
    error('snapshot-baseline-missing', `Baseline snapshot missing for session ${sessionId}. Cannot restore.`, { sessionId }),
} as const;

export async function resolveSnapshot(
  projectDir: string,
  sessionId: string,
  idOrName: string,
): Promise<SnapshotManifest> {
  try {
    return await readManifest(projectDir, sessionId, idOrName);
  } catch {
    // Not an exact ID match — scan by name
  }

  const ids = await listSnapshotIds(projectDir, sessionId);
  const matches: SnapshotManifest[] = [];

  for (const id of ids) {
    try {
      const manifest = await readManifest(projectDir, sessionId, id);
      if (manifest.name === idOrName) {
        matches.push(manifest);
      }
    } catch {
      // Skip corrupted manifests
    }
  }

  if (matches.length > 1) {
    const ids = matches.map(m => m.id).join(', ');
    throw snapshotRestoreError.ambiguousName(idOrName, ids);
  }
  const [first] = matches;
  if (!first) {
    throw snapshotRestoreError.notFound(idOrName);
  }
  return first;
}

export async function restoreSnapshot(opts: RestoreOptions): Promise<RestoreResult> {
  const { projectDir, sessionId, idOrName, force = false, bus } = opts;

  const manifest = await resolveSnapshot(projectDir, sessionId, idOrName);
  const release = await acquireSnapshotLock(projectDir, sessionId);

  const restoredPaths: string[] = [];
  const conflictedPaths: string[] = [];
  const forcedPaths: string[] = [];
  const missingSnapshotFiles: string[] = [];

  try {
    let baselineManifest: SnapshotManifest;
    try {
      baselineManifest = await readManifest(projectDir, sessionId, SNAPSHOT_BASELINE_ID);
    } catch {
      throw snapshotRestoreError.baselineMissing(sessionId);
    }

    const snapshotEntryByPath = new Map(manifest.fileEntries.map(e => [e.path, e]));
    const baselineEntryByPath = new Map(baselineManifest.fileEntries.map(e => [e.path, e]));

    for (const path of Object.keys(manifest.fileHashes)) {
      const absPath = join(projectDir, path);

      let sourceFilePath: string;
      let expectedBlobHash: string;
      const snapshotEntry = snapshotEntryByPath.get(path);
      if (snapshotEntry) {
        sourceFilePath = join(
          snapshotFilesDir(projectDir, sessionId, manifest.id),
          snapshotEntry.encodedName,
        );
        expectedBlobHash = snapshotEntry.hash;
      } else {
        const baselineEntry = baselineEntryByPath.get(path);
        if (!baselineEntry) {
          missingSnapshotFiles.push(path);
          continue;
        }
        sourceFilePath = join(
          snapshotFilesDir(projectDir, sessionId, SNAPSHOT_BASELINE_ID),
          baselineEntry.encodedName,
        );
        expectedBlobHash = baselineEntry.hash;
      }

      const sourceHash = await hashFile(sourceFilePath);
      if (sourceHash === null) {
        missingSnapshotFiles.push(path);
        continue;
      }

      // Refuse to write a blob whose stored bytes do not match the manifest
      // hash recorded when the snapshot was captured. A mismatch means the
      // backing blob was corrupted or replaced after capture, so writing it
      // would silently install wrong content and call it a restore.
      if (sourceHash !== expectedBlobHash) {
        missingSnapshotFiles.push(path);
        continue;
      }

      const currentHash = await hashFile(absPath);
      const snapshotHash = manifest.fileHashes[path];

      if (currentHash === snapshotHash || currentHash === null) {
        const contents = await readFile(sourceFilePath);
        await mkdir(dirname(absPath), { recursive: true });
        await writeFile(absPath, contents);
        restoredPaths.push(path);
      } else if (force) {
        const contents = await readFile(sourceFilePath);
        await mkdir(dirname(absPath), { recursive: true });
        await writeFile(absPath, contents);
        forcedPaths.push(path);
      } else {
        conflictedPaths.push(path);
      }
    }
  } finally {
    await release();
  }

  if (bus) {
    if (conflictedPaths.length > 0 && !force) {
      bus.publish({
        type: 'snapshot_restore_conflict',
        ts: Date.now(),
        snapshotId: manifest.id,
        conflictedPaths,
      });
    }
    bus.publish({
      type: 'snapshot_restored',
      ts: Date.now(),
      snapshotId: manifest.id,
      restoredCount: restoredPaths.length,
      conflictedCount: conflictedPaths.length,
      forcedCount: forcedPaths.length,
      forced: force,
    });
  }

  return {
    snapshotId: manifest.id,
    restoredPaths,
    conflictedPaths,
    forcedPaths,
    missingSnapshotFiles,
  };
}
