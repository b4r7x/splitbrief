import { readFile } from 'node:fs/promises';
import { existsSync, realpathSync, lstatSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, relative, isAbsolute, dirname, basename, sep } from 'node:path';
import { z } from 'zod';
import { DIPTYCH_DIR, LOCKFILE, SESSIONS_DIR } from '../../core/paths.js';
import { writeSecureFileAsync } from '../../lib/fs.js';
import { HEARTBEAT_STALENESS_MS } from './constants.js';
import { WorkflowModeSchema } from '../../core/schemas/enums.js';
import { error } from '../../utils/error.js';

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
  | { alive: false; crashed: boolean; data: LockfileData | null };

const sessionIoError = {
  symlinkRead: (path: string) =>
    error('session-io-read', `Refusing to read through symlink: ${path}`, { path }),
  symlinkWrite: (path: string) =>
    error('session-io-write', `Refusing to write through symlink: ${path}`, { path }),
  escapesRoot: (path: string, root: string) =>
    error('session-io-escape', `Path escapes session root`, { path, root }),
  mismatchedSessionId: (expected: string, actual: string) =>
    error(
      'session-io-mismatched-id',
      `Lockfile sessionId '${actual}' does not match expected '${expected}'`,
      { expected, actual },
    ),
};

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function assertNoSessionPathSymlink(sessionDir: string): void {
  const resolved = resolve(sessionDir);
  const marker = `${sep}${DIPTYCH_DIR}${sep}${SESSIONS_DIR}${sep}`;
  const markerIndex = resolved.indexOf(marker);
  const startIndex = markerIndex === -1 ? resolved.length : markerIndex + 1;
  const suffix = resolved.slice(startIndex).split(sep).filter(Boolean);
  let current = resolved.slice(0, startIndex);
  if (current.endsWith(sep) && current !== sep) current = current.slice(0, -1);

  for (const part of suffix) {
    current = current.length === 0 || current === sep ? `${sep}${part}` : `${current}${sep}${part}`;
    try {
      if (lstatSync(current).isSymbolicLink()) {
        throw sessionIoError.symlinkRead(current);
      }
    } catch (err: unknown) {
      if (
        err instanceof Error &&
        typeof (err as { kind?: unknown }).kind === 'string' &&
        String((err as { kind?: unknown }).kind).startsWith('session-io-')
      ) {
        throw err;
      }
    }
  }
}

export function assertSessionConfinement(filePath: string, sessionDir: string): void {
  assertNoSessionPathSymlink(sessionDir);
  const realSession = realpathSync(sessionDir);

  try {
    const st = lstatSync(filePath);
    if (st.isSymbolicLink()) {
      throw sessionIoError.symlinkRead(filePath);
    }
    const realFile = realpathSync(filePath);
    if (!isInside(realSession, realFile)) {
      throw sessionIoError.escapesRoot(filePath, sessionDir);
    }
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      typeof (err as { kind?: unknown }).kind === 'string' &&
      String((err as { kind?: unknown }).kind).startsWith('session-io-')
    ) {
      throw err;
    }
    try {
      const realParent = realpathSync(dirname(filePath));
      if (!isInside(realSession, realParent)) {
        throw sessionIoError.escapesRoot(filePath, sessionDir);
      }
    } catch {
      throw sessionIoError.escapesRoot(filePath, sessionDir);
    }
  }
}

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

async function updateLockfile(
  sessionDir: string,
  mutate: (data: LockfileData) => void,
): Promise<void> {
  const data = await readLockfile(sessionDir);
  if (!data) return;
  mutate(data);
  await writeSecureFileAsync(lockfilePath(sessionDir), JSON.stringify(data));
}

export async function updateHeartbeat(sessionDir: string): Promise<void> {
  await updateLockfile(sessionDir, (data) => {
    if (data.exitedAt !== undefined) return;
    data.lastAliveMs = Date.now();
  });
}

export async function markExited(sessionDir: string, exitCode: number): Promise<void> {
  await updateLockfile(sessionDir, (data) => {
    data.exitedAt = Date.now();
    data.exitCode = exitCode;
  });
}

export async function markCrashed(
  sessionDir: string,
  signal: string,
  cause?: string,
): Promise<void> {
  await updateLockfile(sessionDir, (data) => {
    data.signal = signal;
    if (cause !== undefined) data.cause = cause;
    if (data.exitedAt === undefined) data.exitedAt = Date.now();
  });
}

export async function markSignaled(sessionDir: string, signal: string): Promise<void> {
  await updateLockfile(sessionDir, (data) => {
    data.signal = signal;
    if (data.exitedAt === undefined) data.exitedAt = Date.now();
  });
}

export async function readLockfile(sessionDir: string): Promise<LockfileData | null> {
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
    return { alive: false, crashed: true, data };
  }

  return { alive: true, data };
}
