import { writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { z } from 'zod';
import { LOCKFILE } from '../../core/paths.js';
import { SECURE_FILE_MODE } from '../../lib/fs.js';
import { HEARTBEAT_STALENESS_MS } from './constants.js';

const LockfileDataSchema = z.object({
  version: z.literal(1),
  pid: z.number().int().positive(),
  startTimeMs: z.number(),
  lastAliveMs: z.number(),
  sessionId: z.string(),
  mode: z.string(),
  feature: z.string(),
  exitedAt: z.number().optional(),
  exitCode: z.number().optional(),
  signal: z.string().optional(),
  cause: z.string().optional(),
});

export type LockfileData = z.infer<typeof LockfileDataSchema>;

export type ServerStatus =
  | { alive: true; data: LockfileData }
  | { alive: false; crashed: boolean; data: LockfileData | null };

function lockfilePath(sessionDir: string): string {
  return join(sessionDir, LOCKFILE);
}

export async function writeLockfile(
  sessionDir: string,
  data: Omit<LockfileData, 'version'>,
): Promise<void> {
  const payload: LockfileData = { version: 1, ...data };
  await writeFile(lockfilePath(sessionDir), JSON.stringify(payload), { mode: SECURE_FILE_MODE });
}

export async function updateHeartbeat(sessionDir: string): Promise<void> {
  const data = await readLockfile(sessionDir);
  if (!data) return;
  if (data.exitedAt !== undefined) return;
  data.lastAliveMs = Date.now();
  await writeFile(lockfilePath(sessionDir), JSON.stringify(data), { mode: SECURE_FILE_MODE });
}

export async function markExited(sessionDir: string, exitCode: number): Promise<void> {
  const data = await readLockfile(sessionDir);
  if (!data) return;
  data.exitedAt = Date.now();
  data.exitCode = exitCode;
  await writeFile(lockfilePath(sessionDir), JSON.stringify(data), { mode: SECURE_FILE_MODE });
}

export async function markCrashed(
  sessionDir: string,
  signal: string,
  cause?: string,
): Promise<void> {
  const data = await readLockfile(sessionDir);
  if (!data) return;
  data.signal = signal;
  if (cause !== undefined) data.cause = cause;
  if (data.exitedAt === undefined) data.exitedAt = Date.now();
  await writeFile(lockfilePath(sessionDir), JSON.stringify(data), { mode: SECURE_FILE_MODE });
}

export async function markSignaled(sessionDir: string, signal: string): Promise<void> {
  const data = await readLockfile(sessionDir);
  if (!data) return;
  data.signal = signal;
  if (data.exitedAt === undefined) data.exitedAt = Date.now();
  await writeFile(lockfilePath(sessionDir), JSON.stringify(data), { mode: SECURE_FILE_MODE });
}

export async function readLockfile(sessionDir: string): Promise<LockfileData | null> {
  const p = lockfilePath(sessionDir);
  if (!existsSync(p)) return null;
  try {
    const raw = await readFile(p, 'utf-8');
    return LockfileDataSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

function isProcessAliveByPid(pid: number, startTimeMs: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }

  // PID-reuse guard: compare start time via `ps`
  try {
    const lstart = execSync(`ps -o lstart= -p ${pid}`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    const psTime = Date.parse(lstart);
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

  // Rule 1: no lockfile
  if (!data) return { alive: false, crashed: false, data: null };

  // Rule 2: clean exit recorded
  if (data.exitedAt !== undefined) return { alive: false, crashed: false, data };

  // Rule 3: process gone (PID check including PID-reuse guard)
  if (!isProcessAliveByPid(data.pid, data.startTimeMs)) {
    return { alive: false, crashed: true, data };
  }

  // Rule 4: heartbeat stale
  if (Date.now() - data.lastAliveMs > HEARTBEAT_STALENESS_MS) {
    return { alive: false, crashed: true, data };
  }

  // Rule 5: alive
  return { alive: true, data };
}
