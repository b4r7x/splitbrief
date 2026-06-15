import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { lstatSync, realpathSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import type {
  RunSnapshotKind,
  RunSnapshotLedger,
  SnapshotManifest,
} from '../../core/schemas/snapshot.js';
import { RunSnapshotLedgerSchema } from '../../core/schemas/snapshot.js';
import { SNAPSHOT_BASELINE_ID, sessionDir, snapshotsDir } from '../../core/paths.js';
import { writeConfinedSecureFileAsync } from '../../lib/fs.js';
import {
  assertExistingPathConfined,
  assertPathConfined,
  assertWritablePathConfined,
} from '../../lib/path-confinement.js';
import { error } from '../../utils/error.js';
import { nowIso } from '../../utils/format-time.js';
import { isENOENT } from '../../lib/process/errors.js';
import { resolveValidatedBlobPath } from './blob-resolver.js';
import { createSnapshot } from './create.js';
import { hashFile } from './files.js';
import { readManifest } from './manifest.js';
import type {
  AcceptRunSnapshotResult,
  RejectRunSnapshotResult,
} from '../../core/runtime/commands/types.js';

export const ACCEPTED_RUN_SNAPSHOT_NAME = 'accepted-run';
const RUN_LEDGER_FILE = 'run-ledger.json';

function runLedgerPath(projectDir: string, sessionId: string): string {
  return join(snapshotsDir(projectDir, sessionId), RUN_LEDGER_FILE);
}

async function readRunLedger(
  projectDir: string,
  sessionId: string,
): Promise<RunSnapshotLedger | null> {
  const target = runLedgerPath(projectDir, sessionId);
  try {
    const st = lstatSync(target);
    if (st.isSymbolicLink()) {
      throw error(
        'snapshot-run-ledger-symlink',
        `Refusing to read run ledger through symlink: ${target}`,
        { target },
      );
    }
  } catch (cause: unknown) {
    if (!isENOENT(cause)) throw cause;
    return null;
  }

  const sessionRoot = realpathSync(sessionDir(projectDir, sessionId));
  const realFile = realpathSync(target);
  if (!realFile.startsWith(`${sessionRoot}/`) && realFile !== sessionRoot) {
    throw error(
      'snapshot-run-ledger-escape',
      `Run ledger path escapes session directory: ${target}`,
      { target, sessionRoot, realFile },
    );
  }

  try {
    const raw = await readFile(target, 'utf-8');
    const ledger = RunSnapshotLedgerSchema.parse(JSON.parse(raw));
    if (ledger.sessionId !== sessionId) {
      throw error(
        'snapshot-run-ledger-session-mismatch',
        `Run ledger belongs to session ${ledger.sessionId}, not ${sessionId}`,
        { expectedSessionId: sessionId, actualSessionId: ledger.sessionId },
      );
    }
    return ledger;
  } catch (cause) {
    if (cause !== null && typeof cause === 'object' && 'kind' in cause) throw cause;
    return null;
  }
}

async function writeRunLedger(
  projectDir: string,
  sessionId: string,
  ledger: RunSnapshotLedger,
): Promise<void> {
  const target = runLedgerPath(projectDir, sessionId);
  await writeConfinedSecureFileAsync(
    projectDir,
    relative(projectDir, target),
    `${JSON.stringify(ledger, null, 2)}\n`,
  );
}

async function createRunLedger(opts: {
  projectDir: string;
  sessionId: string;
  runSnapshot: SnapshotManifest;
  runSnapshotKind?: RunSnapshotKind;
  accepted: boolean;
  rejected: boolean;
}): Promise<RunSnapshotLedger> {
  const previous = await readRunLedger(opts.projectDir, opts.sessionId);
  const runSnapshotIds = [...(previous?.runSnapshotIds ?? []), opts.runSnapshot.id].filter(
    (id, index, ids) => ids.indexOf(id) === index,
  );
  const runSnapshotKinds = {
    ...(previous?.runSnapshotKinds ?? {}),
    ...(opts.runSnapshotKind !== undefined && { [opts.runSnapshot.id]: opts.runSnapshotKind }),
  };
  const now = nowIso();

  return {
    version: 1,
    sessionId: opts.sessionId,
    runSnapshotIds,
    ...(Object.keys(runSnapshotKinds).length > 0 && { runSnapshotKinds }),
    accepted: opts.accepted,
    rejected: opts.rejected,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
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

  // Validate the baseline blob (hex `encodedName`, decodes back to `path`, hash
  // matches the manifest) before reading it, so a tampered baseline manifest
  // cannot restore arbitrary outside content into the working tree.
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
  // Realpath-aware write confinement: a parent directory replaced with a symlink
  // after capture must not redirect the restore outside the project.
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
    return {
      status: 'rejected',
      snapshotId: ledger.runSnapshotIds.at(-1) ?? '',
      restoredPaths: [],
      deletedPaths: [],
      conflictedPaths: [],
      missingSnapshotFiles: [],
    };
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
      // Realpath-aware confinement on the existing target: a parent directory
      // swapped for a symlink after capture must not let reject delete an
      // outside file that lexical confinement would have allowed.
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
