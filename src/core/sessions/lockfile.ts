import { readFile, stat } from 'node:fs/promises';
import { writeSecureFileAsync } from '../../lib/fs.js';
import { currentProcessStartTimeMs } from '../../lib/process/start-time.js';
import { error } from '../../utils/error.js';
import { warnError } from '../../lib/warn.js';
import {
  checkSessionLockStatus,
  parseSessionLockfileData,
  readSessionLockfileData,
  sessionLockfilePath,
  type LockfileData,
} from './lockfile-status.js';

export type { LockfileData } from './lockfile-status.js';

export type SessionLivenessStatus =
  | { alive: true; data: LockfileData }
  | { alive: false; processAlive?: boolean; data: LockfileData | null };

const lockfileWriteError = {
  conflicted: (path: string, attempts: number) =>
    error(
      'session-lockfile-write-conflicted',
      `Lockfile '${path}' was rewritten by another process during all ${attempts} update attempts`,
      { path, attempts },
    ),
};

export async function writeLockfile(
  sessionDir: string,
  data: Omit<LockfileData, 'version'>,
): Promise<void> {
  const payload: LockfileData = {
    version: 1,
    ...data,
    startTimeMs: data.pid === process.pid ? currentProcessStartTimeMs() : data.startTimeMs,
  };
  await writeSecureFileAsync(sessionLockfilePath(sessionDir), JSON.stringify(payload));
}

async function readLockfileSnapshot(
  p: string,
  sessionDir: string,
): Promise<{ data: LockfileData; raw: string; mtimeMs: number } | null> {
  try {
    const mtimeMs = (await stat(p)).mtimeMs;
    const raw = await readFile(p, 'utf-8');
    const result = parseSessionLockfileData(raw, { sessionDir });
    return result.kind === 'valid' ? { data: result.data, raw, mtimeMs } : null;
  } catch {
    return null;
  }
}

// Read-modify-rewrite with a content/mtime compare-and-swap, serialized through a
// per-session write queue. The heartbeat and the exit handler can both reach this
// concurrently; without serialization an in-flight heartbeat that read the file before
// the exit record was written would rewrite the stale snapshot and erase exitedAt. The
// queue guarantees each read-modify-rewrite runs to completion before the next begins,
// so the mutate callback (which skips when exitedAt is present) always sees the freshest
// on-disk state. The CAS is a second line of defense against a writer outside this
// process.
const lockfileWriteChains = new Map<string, Promise<void>>();

const UPDATE_LOCKFILE_ATTEMPTS = 5;

async function readModifyWrite(
  p: string,
  sessionDir: string,
  mutate: (data: LockfileData) => void,
  mustWin: boolean,
): Promise<void> {
  for (let attempt = 0; attempt < UPDATE_LOCKFILE_ATTEMPTS; attempt++) {
    const current = await readLockfileSnapshot(p, sessionDir);
    if (!current) return;
    mutate(current.data);
    const lastAttempt = attempt === UPDATE_LOCKFILE_ATTEMPTS - 1;
    const latest = await readLockfileSnapshot(p, sessionDir);
    const conflicted =
      latest !== null && (latest.mtimeMs !== current.mtimeMs || latest.raw !== current.raw);
    if (conflicted && !(mustWin && lastAttempt)) continue;
    await writeSecureFileAsync(p, JSON.stringify(current.data));
    return;
  }
  throw lockfileWriteError.conflicted(p, UPDATE_LOCKFILE_ATTEMPTS);
}

async function updateLockfile(
  sessionDir: string,
  mutate: (data: LockfileData) => void,
  mustWin = false,
): Promise<void> {
  const p = sessionLockfilePath(sessionDir);
  const prior = lockfileWriteChains.get(p) ?? Promise.resolve();
  const next = prior.catch(() => {}).then(() => readModifyWrite(p, sessionDir, mutate, mustWin));
  lockfileWriteChains.set(p, next);
  try {
    await next;
  } finally {
    if (lockfileWriteChains.get(p) === next) lockfileWriteChains.delete(p);
  }
}

let heartbeatFailureWarned = false;

export async function updateHeartbeat(sessionDir: string): Promise<void> {
  // Best-effort liveness ping: a transient write failure, a compare-and-swap lost to an
  // out-of-process writer, or a session directory removed out from under an in-flight
  // heartbeat must never reject (it runs detached via setInterval). A persistent failure
  // (disk full) warns once and then stays silent to avoid flooding stderr.
  try {
    await updateLockfile(sessionDir, (data) => {
      if (data.exitedAt !== undefined) return;
      data.lastAliveMs = Date.now();
    });
  } catch (err) {
    if (!heartbeatFailureWarned) {
      heartbeatFailureWarned = true;
      warnError('heartbeat write failed; liveness pings paused', err);
    }
  }
}

export async function markExited(sessionDir: string, exitCode: number): Promise<void> {
  await updateLockfile(
    sessionDir,
    (data) => {
      if (data.exitedAt === undefined) data.exitedAt = Date.now();
      data.exitCode = exitCode;
    },
    true,
  );
}

export function readLockfile(sessionDir: string): LockfileData | null {
  const result = readSessionLockfileData({ sessionDir });
  return result.kind === 'valid' ? result.data : null;
}

export function confinedReadLockfile(
  sessionDir: string,
  expectedSessionId: string,
): LockfileData | null {
  const result = readSessionLockfileData({ sessionDir, expectedSessionId });
  return result.kind === 'valid' ? result.data : null;
}

export function checkSessionLiveness(sessionDir: string): SessionLivenessStatus {
  const status = checkSessionLockStatus({ sessionDir });

  switch (status.kind) {
    case 'missing':
    case 'invalid':
      return { alive: false, data: null };
    case 'exited':
      return { alive: false, data: status.data };
    case 'dead':
      return { alive: false, processAlive: false, data: status.data };
    case 'stale':
      return { alive: false, processAlive: true, data: status.data };
    case 'live':
      return { alive: true, data: status.data };
  }
}
