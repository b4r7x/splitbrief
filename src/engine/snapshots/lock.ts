import { openSync, closeSync, unlinkSync, statSync, writeFileSync, readFileSync } from 'node:fs';
import { snapshotLockPath, snapshotsDir } from '../../core/paths.js';
import { ensureSecureDir } from '../../lib/fs.js';
import { isNodeError } from '../../lib/process/errors.js';
import { canSignalProcess } from '../../lib/process/liveness.js';
import { readProcessStartTimeMs } from '../../lib/process/start-time.js';
import { error } from '../../utils/error.js';

const STALE_LOCK_MS = 60_000;

interface LockPayload {
  pid: number;
  startedAt: number;
}

function processStartMs(): number {
  return Date.now() - process.uptime() * 1000;
}

function readLockPayload(lockPath: string): LockPayload | null {
  try {
    return JSON.parse(readFileSync(lockPath, 'utf-8'));
  } catch {
    return null;
  }
}

function writeLockPayload(lockPath: string, payload: LockPayload): void {
  writeFileSync(lockPath, JSON.stringify(payload));
}

async function isProcessAlive(pid: number, startedAt: number): Promise<boolean> {
  if (!canSignalProcess(pid)) return false;

  const psTime = readProcessStartTimeMs(pid);
  if (psTime !== null && Math.abs(psTime - startedAt) > 2000) return false;

  return true;
}

export async function acquireSnapshotLock(
  projectDir: string,
  sessionId: string,
): Promise<() => Promise<void>> {
  const lockPath = snapshotLockPath({ projectDir, sessionId });
  const dir = snapshotsDir({ projectDir, sessionId });
  ensureSecureDir(dir);

  const ownPayload: LockPayload = { pid: process.pid, startedAt: processStartMs() };

  const busy = () =>
    error(
      'snapshot-lock-busy',
      `Another snapshot operation is in progress for this session (lock: ${lockPath}).`,
    );

  const tryAcquire = async (isRetry: boolean): Promise<void> => {
    try {
      const fd = openSync(lockPath, 'wx');
      closeSync(fd);
      writeLockPayload(lockPath, ownPayload);
    } catch (err: unknown) {
      if (isNodeError(err) && err.code === 'EEXIST') {
        if (!isRetry) {
          let mtime: number;
          try {
            mtime = statSync(lockPath).mtimeMs;
          } catch {
            throw busy();
          }
          if (Date.now() - mtime > STALE_LOCK_MS) {
            const payload = readLockPayload(lockPath);
            if (payload !== null && (await isProcessAlive(payload.pid, payload.startedAt))) {
              throw busy();
            }
            try {
              unlinkSync(lockPath);
            } catch {
              // Already removed by another process
            }
            await tryAcquire(true);
            return;
          }
        }
        throw busy();
      }
      throw err;
    }
  };

  await tryAcquire(false);

  return async () => {
    const current = readLockPayload(lockPath);
    if (
      current !== null &&
      (current.pid !== ownPayload.pid || current.startedAt !== ownPayload.startedAt)
    ) {
      return;
    }
    try {
      unlinkSync(lockPath);
    } catch {
      // Already removed
    }
  };
}
