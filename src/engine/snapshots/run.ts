import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { SnapshotManifest } from '../../core/schemas/snapshot.js';
import {
  SNAPSHOT_BASELINE_ID,
  snapshotFilesDir,
} from '../../core/paths.js';
import {
  createSnapshot,
  hashFile,
  listSnapshots,
  readManifest,
} from './store.js';

export const ACCEPTED_RUN_SNAPSHOT_NAME = 'accepted-run';

export type AcceptRunSnapshotResult = {
  snapshotId: string;
  isFirstSnapshot: boolean;
};

export type RejectRunSnapshotResult =
  | {
    status: 'empty';
  }
  | {
    status: 'accepted';
    snapshotId: string;
  }
  | {
    status: 'rejected';
    snapshotId: string;
    restoredPaths: string[];
    deletedPaths: string[];
    conflictedPaths: string[];
    missingSnapshotFiles: string[];
  };

async function latestRunSnapshot(projectDir: string, sessionId: string): Promise<SnapshotManifest | null> {
  const { manifests } = await listSnapshots(projectDir, sessionId);
  return manifests[manifests.length - 1] ?? null;
}

async function restoreBaselineFile(opts: {
  projectDir: string;
  sessionId: string;
  path: string;
  baselineEntry: SnapshotManifest['fileEntries'][number] | undefined;
}): Promise<boolean> {
  if (!opts.baselineEntry) return false;

  const sourcePath = join(
    snapshotFilesDir(opts.projectDir, opts.sessionId, SNAPSHOT_BASELINE_ID),
    opts.baselineEntry.encodedName,
  );

  let contents: Buffer;
  try {
    contents = await readFile(sourcePath);
  } catch {
    return false;
  }

  const targetPath = join(opts.projectDir, opts.path);
  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, contents);
  return true;
}

export async function acceptRunSnapshot(
  projectDir: string,
  sessionId: string,
): Promise<AcceptRunSnapshotResult> {
  const result = await createSnapshot({
    projectDir,
    sessionId,
    phase: 'manual',
    name: ACCEPTED_RUN_SNAPSHOT_NAME,
  });
  return {
    snapshotId: result.manifest.id,
    isFirstSnapshot: result.isFirstSnapshot,
  };
}

export async function rejectRunSnapshot(
  projectDir: string,
  sessionId: string,
): Promise<RejectRunSnapshotResult> {
  const latest = await latestRunSnapshot(projectDir, sessionId);
  if (!latest) return { status: 'empty' };
  if (latest.name === ACCEPTED_RUN_SNAPSHOT_NAME) {
    return { status: 'accepted', snapshotId: latest.id };
  }

  const baseline = await readManifest(projectDir, sessionId, SNAPSHOT_BASELINE_ID);
  const baselineEntries = new Map(baseline.fileEntries.map(entry => [entry.path, entry]));
  const paths = new Set([
    ...Object.keys(baseline.fileHashes),
    ...Object.keys(latest.fileHashes),
  ]);

  const restoredPaths: string[] = [];
  const deletedPaths: string[] = [];
  const conflictedPaths: string[] = [];
  const missingSnapshotFiles: string[] = [];

  for (const path of [...paths].sort()) {
    const baselineHash = baseline.fileHashes[path];
    const latestHash = latest.fileHashes[path];
    if (baselineHash === latestHash) continue;

    const currentHash = await hashFile(join(projectDir, path));

    if (baselineHash === undefined) {
      if (currentHash === null) continue;
      if (currentHash !== latestHash) {
        conflictedPaths.push(path);
        continue;
      }
      await unlink(join(projectDir, path));
      deletedPaths.push(path);
      continue;
    }

    if (latestHash === undefined) {
      if (currentHash !== null) {
        conflictedPaths.push(path);
        continue;
      }
      const restored = await restoreBaselineFile({
        projectDir,
        sessionId,
        path,
        baselineEntry: baselineEntries.get(path),
      });
      if (restored) restoredPaths.push(path);
      else missingSnapshotFiles.push(path);
      continue;
    }

    if (currentHash !== latestHash) {
      conflictedPaths.push(path);
      continue;
    }

    const restored = await restoreBaselineFile({
      projectDir,
      sessionId,
      path,
      baselineEntry: baselineEntries.get(path),
    });
    if (restored) restoredPaths.push(path);
    else missingSnapshotFiles.push(path);
  }

  return {
    status: 'rejected',
    snapshotId: latest.id,
    restoredPaths,
    deletedPaths,
    conflictedPaths,
    missingSnapshotFiles,
  };
}
