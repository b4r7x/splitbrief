import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { SnapshotManifest } from '../../core/schemas/snapshot.js';
import { snapshotFilesDir, SNAPSHOT_BASELINE_ID } from '../../core/paths.js';
import type { EventBus } from '../events/types.js';
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

  if (matches.length === 0) {
    throw new Error(`No snapshot found with id or name: ${idOrName}`);
  }
  if (matches.length > 1) {
    const ids = matches.map(m => m.id).join(', ');
    throw new Error(
      `Ambiguous snapshot name '${idOrName}': matches ${ids}. Use the snapshot ID directly.`,
    );
  }
  return matches[0]!;
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
      throw new Error(
        `Baseline snapshot missing for session ${sessionId}. Cannot restore.`,
      );
    }

    const snapshotFileSet = new Set(manifest.fileEntries.map(e => e.path));

    for (const path of Object.keys(manifest.fileHashes)) {
      const absPath = join(projectDir, path);

      let sourceFilePath: string;
      if (snapshotFileSet.has(path)) {
        const entry = manifest.fileEntries.find(e => e.path === path)!;
        sourceFilePath = join(
          snapshotFilesDir(projectDir, sessionId, manifest.id),
          entry.encodedName,
        );
      } else {
        const baselineEntry = baselineManifest.fileEntries.find(e => e.path === path);
        if (!baselineEntry) {
          missingSnapshotFiles.push(path);
          continue;
        }
        sourceFilePath = join(
          snapshotFilesDir(projectDir, sessionId, SNAPSHOT_BASELINE_ID),
          baselineEntry.encodedName,
        );
      }

      const sourceHash = await hashFile(sourceFilePath);
      if (sourceHash === null) {
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
