import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { SnapshotManifest } from '../../../core/schemas/snapshot.js';
import { SNAPSHOT_BASELINE_ID } from '../../../core/paths.js';
import {
  assertExistingPathConfined,
  assertPathConfined,
  assertWritablePathConfined,
} from '../../../lib/path-confinement.js';
import type { RejectRunSnapshotResult } from '../../../core/runtime/commands/types.js';
import { resolveValidatedBlobPath } from '../blob-resolver.js';
import { hashFile } from '../files.js';
import { readManifest } from '../manifest.js';
import {
  ACCEPTED_RUN_SNAPSHOT_NAME,
  createRunLedger,
  readRunLedger,
  resolveLedgerRunSnapshot,
  writeRunLedger,
} from './ledger.js';

async function restoreBaselineFile(opts: {
  projectDir: string;
  sessionId: string;
  path: string;
  baselineEntry: SnapshotManifest['fileEntries'][number] | undefined;
}): Promise<boolean> {
  if (!opts.baselineEntry) return false;

  const sourcePath = await resolveValidatedBlobPath({
    projectDir: opts.projectDir,
    sessionId: opts.sessionId,
    snapshotId: SNAPSHOT_BASELINE_ID,
    path: opts.path,
    entry: opts.baselineEntry,
  });
  if (sourcePath === null) return false;

  let contents: Buffer;
  try {
    contents = await readFile(sourcePath);
  } catch {
    return false;
  }

  const targetPath = join(opts.projectDir, opts.path);
  await mkdir(dirname(targetPath), { recursive: true });
  assertWritablePathConfined(opts.path, opts.projectDir);
  await writeFile(targetPath, contents);
  return true;
}

async function hashProjectFileIfConfined(projectDir: string, path: string): Promise<string | null> {
  assertPathConfined(path, projectDir);
  const filePath = join(projectDir, path);
  try {
    await stat(filePath);
  } catch {
    return null;
  }
  assertExistingPathConfined(path, projectDir);
  return hashFile(filePath);
}

export async function rejectRunSnapshotBody(
  projectDir: string,
  sessionId: string,
): Promise<RejectRunSnapshotResult> {
  const ledger = await readRunLedger(projectDir, sessionId);
  if (ledger?.accepted) {
    return { status: 'accepted', snapshotId: ledger.runSnapshotIds.at(-1) ?? '' };
  }
  if (ledger?.rejected) {
    return {
      status: 'rejected',
      snapshotId: ledger.runSnapshotIds.at(-1) ?? '',
      restoredPaths: [],
      deletedPaths: [],
      conflictedPaths: [],
      missingSnapshotFiles: [],
    };
  }

  if (!ledger) return { status: 'empty' };
  const latest = await resolveLedgerRunSnapshot(projectDir, sessionId, ledger);
  if (!latest) return { status: 'empty' };
  if (latest.name === ACCEPTED_RUN_SNAPSHOT_NAME) {
    return { status: 'accepted', snapshotId: latest.id };
  }

  const baseline = await readManifest(projectDir, sessionId, SNAPSHOT_BASELINE_ID);
  const baselineEntries = new Map(baseline.fileEntries.map((entry) => [entry.path, entry]));
  const paths = new Set([...Object.keys(baseline.fileHashes), ...Object.keys(latest.fileHashes)]);

  const restoredPaths: string[] = [];
  const deletedPaths: string[] = [];
  const conflictedPaths: string[] = [];
  const missingSnapshotFiles: string[] = [];

  for (const path of [...paths].sort()) {
    assertPathConfined(path, projectDir);

    const baselineHash = baseline.fileHashes[path];
    const latestHash = latest.fileHashes[path];
    if (baselineHash === latestHash) continue;

    const currentHash = await hashProjectFileIfConfined(projectDir, path);

    if (baselineHash === undefined) {
      if (currentHash === null) continue;
      if (currentHash !== latestHash) {
        conflictedPaths.push(path);
        continue;
      }
      assertExistingPathConfined(path, projectDir);
      await unlink(join(projectDir, path));
      deletedPaths.push(path);
      continue;
    }

    if (latestHash === undefined) {
      if (currentHash === baselineHash) continue;
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

    if (currentHash === baselineHash) continue;

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

  const result: RejectRunSnapshotResult = {
    status: 'rejected',
    snapshotId: latest.id,
    restoredPaths,
    deletedPaths,
    conflictedPaths,
    missingSnapshotFiles,
  };

  const fullyRejected = conflictedPaths.length === 0 && missingSnapshotFiles.length === 0;
  const nextLedger = await createRunLedger({
    projectDir,
    sessionId,
    runSnapshot: latest,
    accepted: false,
    rejected: fullyRejected,
  });
  await writeRunLedger(projectDir, sessionId, nextLedger);
  return result;
}
