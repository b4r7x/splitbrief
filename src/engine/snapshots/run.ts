import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { RunSnapshotKind, RunSnapshotLedger, SnapshotManifest } from '../../core/schemas/snapshot.js';
import { RunSnapshotLedgerSchema } from '../../core/schemas/snapshot.js';
import {
  SNAPSHOT_BASELINE_ID,
  snapshotFilesDir,
  snapshotsDir,
} from '../../core/paths.js';
import { ensureSecureDir, SECURE_FILE_MODE } from '../../lib/fs.js';
import {
  createSnapshot,
  hashFile,
  readManifest,
} from './store.js';

export const ACCEPTED_RUN_SNAPSHOT_NAME = 'accepted-run';
const RUN_LEDGER_FILE = 'run-ledger.json';

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

function runLedgerPath(projectDir: string, sessionId: string): string {
  return join(snapshotsDir(projectDir, sessionId), RUN_LEDGER_FILE);
}

function aggregateManifestHash(manifest: SnapshotManifest): string {
  const hash = createHash('sha256');
  for (const [path, fileHash] of Object.entries(manifest.fileHashes).sort(([a], [b]) => a.localeCompare(b))) {
    hash.update(path);
    hash.update('\0');
    hash.update(fileHash);
    hash.update('\0');
  }
  return hash.digest('hex');
}

async function readRunLedger(projectDir: string, sessionId: string): Promise<RunSnapshotLedger | null> {
  try {
    const raw = await readFile(runLedgerPath(projectDir, sessionId), 'utf-8');
    return RunSnapshotLedgerSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

async function writeRunLedger(projectDir: string, sessionId: string, ledger: RunSnapshotLedger): Promise<void> {
  const dir = snapshotsDir(projectDir, sessionId);
  ensureSecureDir(dir);
  const target = runLedgerPath(projectDir, sessionId);
  const tmp = `${target}.tmp`;
  await writeFile(tmp, `${JSON.stringify(ledger, null, 2)}\n`, { mode: SECURE_FILE_MODE });
  await rename(tmp, target);
}

async function createRunLedger(opts: {
  projectDir: string;
  sessionId: string;
  runSnapshot: SnapshotManifest;
  runSnapshotKind?: RunSnapshotKind;
  accepted: boolean;
  rejected: boolean;
}): Promise<RunSnapshotLedger> {
  let beforeHash: string | null = null;
  try {
    beforeHash = aggregateManifestHash(await readManifest(opts.projectDir, opts.sessionId, SNAPSHOT_BASELINE_ID));
  } catch {
    beforeHash = null;
  }

  const previous = await readRunLedger(opts.projectDir, opts.sessionId);
  const runSnapshotIds = [
    ...(previous?.runSnapshotIds ?? []),
    opts.runSnapshot.id,
  ].filter((id, index, ids) => ids.indexOf(id) === index);
  const runSnapshotKinds = {
    ...(previous?.runSnapshotKinds ?? {}),
    ...(opts.runSnapshotKind !== undefined && { [opts.runSnapshot.id]: opts.runSnapshotKind }),
  };
  const now = new Date().toISOString();

  return {
    version: 1,
    sessionId: opts.sessionId,
    runSnapshotIds,
    ...(Object.keys(runSnapshotKinds).length > 0 && { runSnapshotKinds }),
    accepted: opts.accepted,
    rejected: opts.rejected,
    beforeHash,
    lastDiptychHash: aggregateManifestHash(opts.runSnapshot),
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
    ...(opts.runSnapshot.taskIndex !== undefined && { taskIndex: opts.runSnapshot.taskIndex }),
  };
}

export async function readRunSnapshotLedger(
  projectDir: string,
  sessionId: string,
): Promise<RunSnapshotLedger | null> {
  return readRunLedger(projectDir, sessionId);
}

// Public API for the orchestrator: register a snapshot as belonging to the
// current run. Must be called every time the planner/implementer creates an
// auto-snapshot so that `rejectRunSnapshot()` knows exactly which snapshot
// IDs the run produced. Without this, `rejectRunSnapshot()` would have to
// guess from the latest manual snapshot — which can be an unrelated snapshot
// the user created themselves and is not safe to roll back to.
export async function recordRunSnapshot(
  projectDir: string,
  sessionId: string,
  snapshot: SnapshotManifest,
  kind?: RunSnapshotKind,
): Promise<void> {
  const previous = await readRunLedger(projectDir, sessionId);
  if (previous?.accepted || previous?.rejected) return;
  const ledger = await createRunLedger({
    projectDir,
    sessionId,
    runSnapshot: snapshot,
    ...(kind !== undefined && { runSnapshotKind: kind }),
    accepted: false,
    rejected: false,
  });
  await writeRunLedger(projectDir, sessionId, ledger);
}

async function resolveLedgerRunSnapshot(
  projectDir: string,
  sessionId: string,
  ledger: RunSnapshotLedger,
): Promise<SnapshotManifest | null> {
  const latestId = ledger.runSnapshotIds.at(-1);
  if (!latestId) return null;
  try {
    return await readManifest(projectDir, sessionId, latestId);
  } catch {
    return null;
  }
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

  // Verify the stored baseline blob matches the manifest hash before
  // overwriting the live file. A corrupted blob must surface as missing
  // rather than silently corrupting the user's working tree.
  const blobHash = await hashFile(sourcePath);
  if (blobHash === null || blobHash !== opts.baselineEntry.hash) return false;

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
  const ledger = await createRunLedger({
    projectDir,
    sessionId,
    runSnapshot: result.manifest,
    runSnapshotKind: 'accepted-run',
    accepted: true,
    rejected: false,
  });
  await writeRunLedger(projectDir, sessionId, ledger);
  return {
    snapshotId: result.manifest.id,
    isFirstSnapshot: result.isFirstSnapshot,
  };
}

export async function rejectRunSnapshot(
  projectDir: string,
  sessionId: string,
): Promise<RejectRunSnapshotResult> {
  const ledger = await readRunLedger(projectDir, sessionId);
  if (ledger?.accepted) {
    return { status: 'accepted', snapshotId: ledger.runSnapshotIds.at(-1) ?? '' };
  }
  if (ledger?.rejected) {
    return { status: 'rejected', snapshotId: ledger.runSnapshotIds.at(-1) ?? '', restoredPaths: [], deletedPaths: [], conflictedPaths: [], missingSnapshotFiles: [] };
  }

  // Run rejection must operate on a snapshot recorded by the run ledger,
  // never on an unrelated latest manual snapshot. If no run ledger exists,
  // there is nothing to reject — surface that as `empty` instead of
  // silently overwriting the user's working tree from arbitrary state.
  if (!ledger) return { status: 'empty' };
  const latest = await resolveLedgerRunSnapshot(projectDir, sessionId, ledger);
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

  // Only mark the ledger as rejected when the rejection is fully complete.
  // Any conflict or missing blob must keep the run retryable — the user
  // resolves the conflict (or restores the blob) and runs `/reject-run
  // confirm` again. If we wrote `rejected: true` here, the second attempt
  // would short-circuit and silently ignore the still-dirty paths.
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
