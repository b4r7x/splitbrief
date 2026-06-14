import { readFile, stat } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, basename } from 'node:path';
import { z } from 'zod';
import { LOCKFILE } from '../../core/paths.js';
import { writeSecureFileAsync } from '../../lib/fs.js';
import { assertSessionConfinement } from '../../core/sessions/confinement.js';
import { HEARTBEAT_STALENESS_MS } from './constants.js';
import { WorkflowModeSchema } from '../../core/schemas/enums.js';
import { error } from '../../utils/error.js';
import { warnError } from '../../lib/warn.js';

const LockfileDataSchema = z.object({
  version: z.literal(1),
  pid: z.number().int().positive(),
  startTimeMs: z.number(),
  lastAliveMs: z.number(),
  sessionId: z.string(),
  mode: WorkflowModeSchema,
  feature: z.string(),
  authToken: z.string().optional(),
  exitedAt: z.number().optional(),
  exitCode: z.number().optional(),
  signal: z.string().optional(),
  cause: z.string().optional(),
});

export type LockfileData = z.infer<typeof LockfileDataSchema>;

export type ServerStatus =
  | { alive: true; data: LockfileData }
  | { alive: false; crashed: boolean; processAlive?: boolean; data: LockfileData | null };

const sessionIoError = {
  mismatchedSessionId: (expected: string, actual: string) =>
    error(
      'session-io-mismatched-id',
      `Lockfile sessionId '${actual}' does not match expected '${expected}'`,
      { expected, actual },
    ),
};

export function validateLockfileSessionId(sessionDir: string, data: LockfileData): void {
  const realSession = realpathSync(sessionDir);
  const expected = basename(realSession);
  if (data.sessionId !== expected) {
    throw sessionIoError.mismatchedSessionId(expected, data.sessionId);
  }
}

function lockfilePath(sessionDir: string): string {
  assertSessionConfinement(resolve(sessionDir, LOCKFILE), sessionDir);
  return resolve(sessionDir, LOCKFILE);
}

export async function writeLockfile(
  sessionDir: string,
  data: Omit<LockfileData, 'version'>,
): Promise<void> {
  const payload: LockfileData = { version: 1, ...data };
  await writeSecureFileAsync(lockfilePath(sessionDir), JSON.stringify(payload));
}

async function readLockfileSnapshot(
  p: string,
  sessionDir: string,
): Promise<{ data: LockfileData; raw: string; mtimeMs: number } | null> {
  if (!existsSync(sessionDir) || !existsSync(p)) return null;
  try {
    const mtimeMs = (await stat(p)).mtimeMs;
    const raw = await readFile(p, 'utf-8');
    const data = LockfileDataSchema.parse(JSON.parse(raw));
    validateLockfileSessionId(sessionDir, data);
    return { data, raw, mtimeMs };
  } catch {
    return null;
  }
}

// Read-modify-rewrite with a content/mtime compare-and-swap, serialized through a
// per-session write queue. The heartbeat and the exit/crash handlers can both
// reach this concurrently; without serialization an in-flight heartbeat that read
// the file before the crash record was written would rewrite the stale snapshot
// and erase exitedAt. The queue guarantees each read-modify-rewrite runs to
// completion before the next begins, so the mutate callback (which skips when
// exitedAt is present) always sees the freshest on-disk state. The CAS is a
// second line of defense against a writer outside this process.
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
}

async function updateLockfile(
  sessionDir: string,
  mutate: (data: LockfileData) => void,
  mustWin = false,
): Promise<void> {
  const p = lockfilePath(sessionDir);
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
  // Best-effort liveness ping: a transient write failure or a session directory removed
  // out from under an in-flight heartbeat must never reject (it runs detached via setInterval).
  // A persistent failure (disk full) warns once and then stays silent to avoid flooding stderr.
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

export async function markCrashed(
  sessionDir: string,
  signal: string,
  cause?: string,
): Promise<void> {
  await updateLockfile(
    sessionDir,
    (data) => {
      data.signal = signal;
      if (cause !== undefined) data.cause = cause;
      if (data.exitedAt === undefined) data.exitedAt = Date.now();
    },
    true,
  );
}

export async function markSignaled(sessionDir: string, signal: string): Promise<void> {
  await updateLockfile(
    sessionDir,
    (data) => {
      data.signal = signal;
      if (data.exitedAt === undefined) data.exitedAt = Date.now();
    },
    true,
  );
}

export async function readLockfile(sessionDir: string): Promise<LockfileData | null> {
  if (!existsSync(sessionDir)) return null;
  const p = lockfilePath(sessionDir);
  if (!existsSync(p)) return null;
  try {
    const raw = await readFile(p, 'utf-8');
    const data = LockfileDataSchema.parse(JSON.parse(raw));
    validateLockfileSessionId(sessionDir, data);
    return data;
  } catch {
    return null;
  }
}

export async function confinedReadLockfile(
  sessionDir: string,
  expectedSessionId: string,
): Promise<LockfileData | null> {
  if (!existsSync(sessionDir)) return null;
  const p = lockfilePath(sessionDir);
  if (!existsSync(p)) return null;
  try {
    const raw = await readFile(p, 'utf-8');
    const data = LockfileDataSchema.parse(JSON.parse(raw));
    validateLockfileSessionId(sessionDir, data);
    if (data.sessionId !== expectedSessionId) {
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

const execFileAsync = promisify(execFile);

async function isProcessAliveByPid(pid: number, startTimeMs: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }

  try {
    const { stdout } = await execFileAsync('ps', ['-o', 'lstart=', '-p', String(pid)]);
    const psTime = Date.parse(stdout.trim());
    if (!Number.isNaN(psTime) && Math.abs(psTime - startTimeMs) > 2000) {
      return false;
    }
  } catch {
    // ps failed: fall through to staleness check
  }

  return true;
}

export async function checkServerStatus(sessionDir: string): Promise<ServerStatus> {
  const data = await readLockfile(sessionDir);

  if (!data) return { alive: false, crashed: false, data: null };

  if (data.exitedAt !== undefined) return { alive: false, crashed: false, data };

  if (!(await isProcessAliveByPid(data.pid, data.startTimeMs))) {
    return { alive: false, crashed: true, data };
  }

  if (Date.now() - data.lastAliveMs > HEARTBEAT_STALENESS_MS) {
    return { alive: false, crashed: true, processAlive: true, data };
  }

  return { alive: true, data };
}
