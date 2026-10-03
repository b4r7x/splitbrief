import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Phase } from '../schemas/enums.js';
import type { Session } from '../schemas/session.js';
import type { Summary } from '../schemas/summary.js';
import type { SessionRef } from '../types/session-ref.js';
import { SessionSchema } from '../schemas/session.js';
import { parsePersistedSession } from './summary-parser.js';
import { loadRunRecord, type RunRecordDeps } from './run-record.js';
import { defaultRunRecordDeps } from './run-record-io.js';
import type { RunStatus } from './run-status.js';
import { sessionDir, sessionsRoot, isValidSessionId, SUMMARY_FILE } from '../paths.js';
import { warnError, warnStderr } from '../../lib/warn.js';
import { isENOENT } from '../../lib/process/errors.js';
import { sessionError } from './errors.js';
import { writeSecureFile } from '../../lib/fs.js';

type SessionRowBase = Readonly<{
  id: string;
  feature: string;
  startedAt: number;
  completedAt: number | null;
  stateVersion: number;
  phase?: Phase | undefined;
}>;

function readSummaryFile(filePath: string, sessionId: string): Session | null {
  try {
    const raw = readFileSync(filePath, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    const result = parsePersistedSession(parsed);
    if (result.status === 'invalid') {
      warnStderr(`Warning: invalid session ${filePath}: ${result.error}`);
      return null;
    }
    if (result.session.id !== sessionId) {
      warnStderr(
        `Warning: session ${filePath} payload id '${result.session.id}' does not match directory '${sessionId}'; using directory id`,
      );
      return { ...result.session, id: sessionId };
    }
    return result.session;
  } catch (err) {
    if (!isENOENT(err)) {
      warnError(`Failed to read session ${filePath}`, err);
    }
    return null;
  }
}

export function saveSummary(ref: SessionRef, session: Session): void {
  const { projectDir, sessionId: id } = ref;
  const result = SessionSchema.safeParse(session);
  if (!result.success) {
    throw sessionError.invalidData(id, result.error.message);
  }
  if (result.data.id !== id) {
    throw sessionError.idMismatch(id, result.data.id);
  }
  writeSecureFile(
    join(sessionDir(projectDir, id), SUMMARY_FILE),
    `${JSON.stringify(session, null, 2)}\n`,
  );
}

export function readSession(ref: SessionRef): Session | null {
  const { projectDir, sessionId } = ref;
  return readSummaryFile(join(sessionDir(projectDir, sessionId), SUMMARY_FILE), sessionId);
}

function startedAtMs(startedAt: string | null): number {
  const parsed = startedAt === null ? Number.NaN : Date.parse(startedAt);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * The row a derived status produces. A complete row carries its summary by
 * contract; a closed run whose summary never reached disk reads as ended.
 */
function rowFor(base: SessionRowBase, status: RunStatus, summary: Summary | null): Session {
  if (status.kind === 'closed') {
    if (status.as === 'complete' && summary !== null) {
      return { ...base, status: 'complete', summary };
    }
    return { ...base, status: 'ended', summary };
  }
  if (status.kind === 'running') return { ...base, status: 'open', summary };
  return { ...base, status: 'open', summary, stop: status.stop.kind };
}

// The listing shows a status and a phase; the evidence ledger and the run
// ledger are not on the row, so a listing never pays to read them.
const LISTING_DEPS: RunRecordDeps = {
  ...defaultRunRecordDeps(),
  readLedger: () => null,
  readCheckpoint: () => null,
};

function sessionRow(ref: SessionRef): Session | null {
  const persisted = readSummaryFile(
    join(sessionDir(ref.projectDir, ref.sessionId), SUMMARY_FILE),
    ref.sessionId,
  );
  const record = loadRunRecord(ref, LISTING_DEPS);
  const state = record.hydration.kind === 'loaded' ? record.hydration.state : null;
  // Without a readable state there is nothing to derive from: the summary the run
  // wrote when it ended is the whole record.
  if (state === null) return persisted;

  return rowFor(
    {
      id: ref.sessionId,
      feature: persisted?.feature ?? record.feature,
      startedAt: persisted?.startedAt ?? startedAtMs(record.startedAt),
      completedAt: persisted?.completedAt ?? null,
      stateVersion: persisted?.stateVersion ?? state.stateVersion,
      phase: state.phase,
    },
    record.status,
    persisted?.summary ?? record.summary,
  );
}

function isValidSessionDirectory(sessionId: string): boolean {
  if (!isValidSessionId(sessionId)) {
    warnError(`Skipping session directory '${sessionId}'`, sessionError.invalidId(sessionId));
    return false;
  }
  return true;
}

export function listSessions(projectDir: string): Session[] {
  const root = sessionsRoot(projectDir);
  if (!existsSync(root)) return [];

  const entries = readdirSync(root, { withFileTypes: true });
  const sessions: Session[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!isValidSessionDirectory(entry.name)) continue;
    const session = sessionRow({ projectDir, sessionId: entry.name });
    if (session) sessions.push(session);
  }

  return sessions.sort((a, b) => b.startedAt - a.startedAt);
}
