import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { z } from 'zod';
import { isNodeError } from '../../lib/process/errors.js';
import { readProcessStartTimeMs } from '../../lib/process/start-time.js';
import { LOCKFILE } from '../paths.js';
import { WorkflowModeSchema } from '../schemas/enums.js';
import { assertSessionConfinement } from './confinement.js';

export const HEARTBEAT_STALENESS_MS = 8000;

export const PROCESS_START_TOLERANCE_MS = 2000;

export type ProcessIdentityStatus = 'live' | 'dead' | 'pid-reused' | 'unknown';

export const LockfileDataSchema = z.object({
  version: z.literal(1),
  pid: z.number().int().positive(),
  startTimeMs: z.number().finite().nonnegative(),
  lastAliveMs: z.number().finite().nonnegative(),
  sessionId: z.string(),
  mode: WorkflowModeSchema,
  feature: z.string(),
  authToken: z.string().optional(),
  exitedAt: z.number().finite().nonnegative().optional(),
  exitCode: z.number().int().optional(),
  signal: z.string().optional(),
  cause: z.string().optional(),
});

export type LockfileData = z.infer<typeof LockfileDataSchema>;

export type SessionLockReadResult =
  | { kind: 'missing' }
  | { kind: 'invalid' }
  | { kind: 'valid'; data: LockfileData };

export type SessionLockStatus =
  | { kind: 'missing' }
  | { kind: 'invalid' }
  | { kind: 'exited'; data: LockfileData }
  | { kind: 'dead'; data: LockfileData; processAlive: false }
  | { kind: 'stale'; data: LockfileData; processAlive: true }
  | { kind: 'live'; data: LockfileData };

export interface SessionLockfileOptions {
  sessionDir: string;
  expectedSessionId?: string | undefined;
}

export interface SessionLockStatusOptions extends SessionLockfileOptions {
  nowMs?: number | undefined;
}

function lockfilePath(sessionDir: string): string {
  const p = resolve(sessionDir, LOCKFILE);
  assertSessionConfinement(p, sessionDir);
  return p;
}

function expectedSessionIdFor(options: SessionLockfileOptions): string | null {
  if (options.expectedSessionId !== undefined) return options.expectedSessionId;
  try {
    return basename(realpathSync(options.sessionDir));
  } catch {
    return null;
  }
}

export function readSessionLockfileData(options: SessionLockfileOptions): SessionLockReadResult {
  if (!existsSync(options.sessionDir)) return { kind: 'missing' };
  const expectedSessionId = expectedSessionIdFor(options);
  if (expectedSessionId === null) return { kind: 'invalid' };

  let p: string;
  try {
    p = lockfilePath(options.sessionDir);
  } catch {
    return { kind: 'invalid' };
  }

  if (!existsSync(p)) return { kind: 'missing' };

  try {
    const parsed = LockfileDataSchema.safeParse(JSON.parse(readFileSync(p, 'utf-8')));
    if (!parsed.success) return { kind: 'invalid' };
    if (parsed.data.sessionId !== expectedSessionId) return { kind: 'invalid' };
    return { kind: 'valid', data: parsed.data };
  } catch {
    return { kind: 'invalid' };
  }
}

function canSignalProcess(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return isNodeError(err) && err.code === 'EPERM';
  }
}

export function checkProcessIdentity(
  pid: number,
  expectedStartTimeMs: number,
): ProcessIdentityStatus {
  const actualStartTimeMs = readProcessStartTimeMs(pid);
  if (actualStartTimeMs !== null && Number.isFinite(expectedStartTimeMs)) {
    return Math.abs(actualStartTimeMs - expectedStartTimeMs) <= PROCESS_START_TOLERANCE_MS
      ? 'live'
      : 'pid-reused';
  }

  if (canSignalProcess(pid)) return 'unknown';
  try {
    process.kill(pid, 0);
    return 'unknown';
  } catch (err) {
    return isNodeError(err) && err.code === 'ESRCH' ? 'dead' : 'unknown';
  }
}

function processMatchesLockfile(data: LockfileData): boolean {
  const identity = checkProcessIdentity(data.pid, data.startTimeMs);
  return identity === 'live' || identity === 'unknown';
}

export function checkSessionLockStatus(options: SessionLockStatusOptions): SessionLockStatus {
  const read = readSessionLockfileData(options);
  if (read.kind !== 'valid') return read;

  const { data } = read;
  if (data.exitedAt !== undefined) return { kind: 'exited', data };
  if (!processMatchesLockfile(data)) return { kind: 'dead', data, processAlive: false };

  const nowMs = options.nowMs ?? Date.now();
  if (nowMs - data.lastAliveMs > HEARTBEAT_STALENESS_MS) {
    return { kind: 'stale', data, processAlive: true };
  }

  return { kind: 'live', data };
}
