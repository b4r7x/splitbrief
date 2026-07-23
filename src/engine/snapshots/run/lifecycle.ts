import type { AcceptRunSnapshotResult } from '../../../core/runtime/commands/types.js';
import { createWriteSequencer } from '../../orchestrator/serial-executor.js';
import { createSnapshot } from '../create.js';
import { ACCEPTED_RUN_SNAPSHOT_NAME, createRunLedger, writeRunLedger } from './ledger.js';
import { rejectRunSnapshotBody } from './rollback.js';
import type { RejectRunSnapshotResult } from '../../../core/runtime/commands/types.js';

const runSnapshotSequencer = createWriteSequencer();

async function acceptRunSnapshotBody(
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

export async function acceptRunSnapshot(
  projectDir: string,
  sessionId: string,
): Promise<AcceptRunSnapshotResult> {
  return runSnapshotSequencer(() => acceptRunSnapshotBody(projectDir, sessionId));
}

export async function rejectRunSnapshot(
  projectDir: string,
  sessionId: string,
): Promise<RejectRunSnapshotResult> {
  return runSnapshotSequencer(() => rejectRunSnapshotBody(projectDir, sessionId));
}
