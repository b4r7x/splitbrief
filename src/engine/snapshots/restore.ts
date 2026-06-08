import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { lstatSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { SnapshotManifest } from '../../core/schemas/snapshot.js';
import { SNAPSHOT_BASELINE_ID } from '../../core/paths.js';
import type { EventBus } from '../events/types.js';
import { error } from '../../utils/error.js';
import { isENOENT } from '../../lib/process/errors.js';
import { assertPathConfined, assertWritablePathConfined } from '../../lib/path-confinement.js';
import { resolveValidatedBlobPath } from './blob-resolver.js';
import { acquireSnapshotLock } from './lock.js';
import { hashFile } from './files.js';
import { listSnapshotIds, readManifest } from './manifest.js';

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
    error(
      'snapshot-name-ambiguous',
      `Ambiguous snapshot name '${idOrName}': matches ${ids}. Use the snapshot ID directly.`,
      { idOrName, ids },
    ),
  baselineMissing: (sessionId: string) =>
    error(
      'snapshot-baseline-missing',
      `Baseline snapshot missing for session ${sessionId}. Cannot restore.`,
      { sessionId },
    ),
} as const;

function assertBlobNotSymlink(blobPath: string): void {
  try {
    if (lstatSync(blobPath).isSymbolicLink()) {
      throw error(
        'snapshot-blob-symlink',
        `Refusing to read snapshot blob through symlink: ${blobPath}`,
        { blobPath },
      );
    }
  } catch (cause: unknown) {
    if (!isENOENT(cause)) throw cause;
  }
}

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
    const ids = matches.map((m) => m.id).join(', ');
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

    const snapshotEntryByPath = new Map(manifest.fileEntries.map((e) => [e.path, e]));
    const baselineEntryByPath = new Map(baselineManifest.fileEntries.map((e) => [e.path, e]));

    for (const path of Object.keys(manifest.fileHashes)) {
      assertPathConfined(path, projectDir);

      const absPath = join(projectDir, path);

      // Validate and resolve the backing blob (hex `encodedName`, decodes to
      // `path`, hash matches the manifest) before any read. A delta entry takes
      // precedence; otherwise fall back to the baseline blob for this path.
      const snapshotEntry = snapshotEntryByPath.get(path);
      const sourceFilePath = snapshotEntry
        ? await resolveValidatedBlobPath({
            projectDir,
            sessionId,
            snapshotId: manifest.id,
            path,
            entry: snapshotEntry,
          })
        : await resolveValidatedBlobPath({
            projectDir,
            sessionId,
            snapshotId: SNAPSHOT_BASELINE_ID,
            path,
            entry: baselineEntryByPath.get(path),
          });
      if (sourceFilePath === null) {
        missingSnapshotFiles.push(path);
        continue;
      }

      const currentHash = await hashFile(absPath);
      const snapshotHash = manifest.fileHashes[path];

      if (currentHash === snapshotHash || currentHash === null) {
        assertBlobNotSymlink(sourceFilePath);
        const contents = await readFile(sourceFilePath);
        await mkdir(dirname(absPath), { recursive: true });
        assertWritablePathConfined(path, projectDir);
        await writeFile(absPath, contents);
        restoredPaths.push(path);
      } else if (force) {
        assertBlobNotSymlink(sourceFilePath);
        const contents = await readFile(sourceFilePath);
        await mkdir(dirname(absPath), { recursive: true });
        assertWritablePathConfined(path, projectDir);
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
