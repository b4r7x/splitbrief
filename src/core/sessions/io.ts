import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
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
import {
  sessionDir,
  sessionsRoot,
  isValidSessionId,
  LOCKFILE,
  STATE_FILE,
  SUMMARY_FILE,
} from '../paths.js';
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
        `Warning: session ${filePath} names the id '${result.session.id}', not its folder '${sessionId}'; the folder name is used`,
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
export function rowFor(base: SessionRowBase, status: RunStatus, summary: Summary | null): Session {
  if (status.kind === 'closed') {
    if (status.as === 'applied' || status.as === 'undone') {
      return summary !== null
        ? { ...base, status: 'complete', summary, apply: status.as }
        : { ...base, status: 'ended', summary, apply: status.as };
    }
    if (status.as === 'discarded') {
      return { ...base, status: 'ended', summary, apply: 'discarded' };
    }
    if (status.as === 'complete' && summary !== null) {
      return { ...base, status: 'complete', summary };
    }
    return { ...base, status: 'ended', summary };
  }
  if (status.kind === 'ready-to-apply') {
    return { ...base, status: 'open', summary, apply: 'ready' };
  }
  if (status.kind === 'running') {
    return { ...base, status: 'open', summary };
  }
  return { ...base, status: 'open', summary, stop: status.stop.kind };
}

// The listing shows a status and a phase; the evidence ledger and the run
// ledger are not on the row, so a listing never pays to read them.
const LISTING_DEPS: RunRecordDeps = {
  ...defaultRunRecordDeps(),
  readLedger: () => null,
  readCheckpoint: () => null,
};

type ListedRow = Readonly<{ row: Session | null; running: boolean }>;

function sessionRow(ref: SessionRef): ListedRow {
  const persisted = readSummaryFile(
    join(sessionDir(ref.projectDir, ref.sessionId), SUMMARY_FILE),
    ref.sessionId,
  );
  const record = loadRunRecord(ref, LISTING_DEPS);
  const state = record.hydration.kind === 'loaded' ? record.hydration.state : null;
  // Without a readable state there is nothing to derive from: the summary the run
  // wrote when it ended is the whole record.
  if (state === null) return { row: persisted, running: false };

  const row = rowFor(
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
  return { row, running: record.status.kind === 'running' };
}

/** The files a row is read from; a write replaces a file, so its inode changes with it. */
function rowSignature(directory: string): string {
  return [STATE_FILE, SUMMARY_FILE, LOCKFILE]
    .map((file) => {
      const stat = statSync(join(directory, file), { throwIfNoEntry: false });
      return stat === undefined ? '-' : `${stat.ino}:${stat.mtimeMs}:${stat.size}`;
    })
    .join('|');
}

type CachedRow = ListedRow & Readonly<{ signature: string }>;

type Listing = Readonly<{ rows: ReadonlyMap<string, CachedRow>; skipped: ReadonlySet<string> }>;

/**
 * The last listing per sessions folder. Home lists the runs every few seconds, and a large state
 * file costs a parse, so a row is read again only when one of its files changed. A running row is
 * always read again: an owner killed without its exit handler changes no file. A folder with an
 * invalid name warns once, when a listing first skips it.
 */
const listingCache = new Map<string, Listing>();

export function listSessions(projectDir: string): Session[] {
  const root = sessionsRoot(projectDir);
  if (!existsSync(root)) {
    listingCache.delete(root);
    return [];
  }

  const entries = readdirSync(root, { withFileTypes: true });
  const previous = listingCache.get(root);
  const rows = new Map<string, CachedRow>();
  const skipped = new Set<string>();
  const sessions: Session[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!isValidSessionId(entry.name)) {
      if (!previous?.skipped.has(entry.name)) {
        warnError(`Skipping session directory '${entry.name}'`, sessionError.invalidId(entry.name));
      }
      skipped.add(entry.name);
      continue;
    }
    const signature = rowSignature(join(root, entry.name));
    const cached = previous?.rows.get(entry.name);
    const listed =
      cached !== undefined && cached.signature === signature && !cached.running
        ? cached
        : { ...sessionRow({ projectDir, sessionId: entry.name }), signature };
    rows.set(entry.name, listed);
    if (listed.row) sessions.push(listed.row);
  }
  listingCache.set(root, { rows, skipped });

  return sessions.sort((a, b) => b.startedAt - a.startedAt);
}
