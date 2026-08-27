import { readFile } from 'node:fs/promises';
import { lstatSync, realpathSync } from 'node:fs';
import { join, relative } from 'node:path';
import type {
  RunSnapshotKind,
  RunSnapshotLedger,
  SnapshotManifest,
} from '../../../core/schemas/snapshot.js';
import { RunSnapshotLedgerSchema } from '../../../core/schemas/snapshot.js';
import { sessionDir, snapshotsDir } from '../../../core/paths.js';
import { writeConfinedSecureFileAsync } from '../../../lib/fs.js';
import { error } from '../../../utils/error.js';
import { nowIso } from '../../../utils/format-time.js';
import { isENOENT } from '../../../lib/process/errors.js';
import { readManifest } from '../manifest.js';

export const ACCEPTED_RUN_SNAPSHOT_NAME = 'accepted-run';
const RUN_LEDGER_FILE = 'run-ledger.json';

function runLedgerPath(projectDir: string, sessionId: string): string {
  return join(snapshotsDir({ projectDir, sessionId }), RUN_LEDGER_FILE);
}

export async function readRunLedger(
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

export async function writeRunLedger(
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

export async function createRunLedger(opts: {
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

export async function resolveLedgerRunSnapshot(
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
