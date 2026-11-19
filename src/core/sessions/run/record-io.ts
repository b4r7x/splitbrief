import { join } from 'node:path';
import { readJsonSafe } from '../../../lib/fs/read.js';
import { matches } from '../../../utils/error.js';
import { readEvidenceLedger } from '../../evidence/ledger-storage.js';
import { RUN_LEDGER_FILE, SUMMARY_FILE, sessionDir, snapshotsDir } from '../../paths.js';
import type { EvidenceLedger } from '../../schemas/evidence.js';
import { RunSnapshotLedgerSchema } from '../../schemas/snapshot.js';
import type { Summary } from '../../schemas/summary.js';
import { loadOwnerWorkflowState } from '../../state/resume-hydration.js';
import type { SessionRef } from '../../types/session-ref.js';
import { checkSessionLiveness } from '../lock/file.js';
import {
  loadRunRecord,
  type RunCheckpoint,
  type RunOwner,
  type RunRecord,
  type RunRecordDeps,
} from './record.js';
import { parsePersistedSession } from '../summary-parser.js';

const isLedgerUnreadable = matches('recovery-evidence-storage');

export function readSessionSummary(ref: SessionRef): Summary | null {
  const raw = readJsonSafe(join(sessionDir(ref.projectDir, ref.sessionId), SUMMARY_FILE));
  if (raw === null) return null;
  const parsed = parsePersistedSession(raw);
  return parsed.status === 'ok' ? parsed.session.summary : null;
}

function readRunCheckpoint(ref: SessionRef): RunCheckpoint | null {
  const raw = readJsonSafe(join(snapshotsDir(ref), RUN_LEDGER_FILE));
  if (raw === null) return null;
  const parsed = RunSnapshotLedgerSchema.safeParse(raw);
  if (!parsed.success) return null;
  if (parsed.data.accepted) return { kind: 'accepted' };
  if (!parsed.data.rejected) return null;
  const { putBack } = parsed.data;
  return { kind: 'rejected', ...(putBack !== undefined && { putBack }) };
}

function readLedger(ref: SessionRef): EvidenceLedger | null {
  try {
    return readEvidenceLedger(ref);
  } catch (cause) {
    if (isLedgerUnreadable(cause)) return null;
    throw cause;
  }
}

export function readRunOwner(
  ref: SessionRef,
  checkLiveness = checkSessionLiveness,
): RunOwner | undefined {
  const status = checkLiveness(sessionDir(ref.projectDir, ref.sessionId));
  if (status.alive) return { kind: 'live', pid: status.data.pid };
  if (status.processAlive === true && status.data !== null) {
    return { kind: 'stale', pid: status.data.pid };
  }
  return undefined;
}

export function defaultRunRecordDeps(checkLiveness = checkSessionLiveness): RunRecordDeps {
  return {
    loadResumeState: loadOwnerWorkflowState,
    readOwner: (ref) => readRunOwner(ref, checkLiveness),
    readSummary: readSessionSummary,
    readLedger,
    readCheckpoint: readRunCheckpoint,
  };
}

/** One run, read from disk through the real readers. The composition root for `loadRunRecord`. */
export function readRunRecord(
  ref: SessionRef,
  reviewNone: boolean,
  checkLiveness = checkSessionLiveness,
): RunRecord {
  return loadRunRecord(ref, defaultRunRecordDeps(checkLiveness), reviewNone);
}
