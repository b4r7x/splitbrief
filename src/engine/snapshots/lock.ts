import { openSync, closeSync, unlinkSync, statSync, writeFileSync, readFileSync } from 'node:fs';
import { snapshotLockPath, snapshotsDir } from '../../core/paths.js';
import { ensureSecureDir } from '../../lib/fs.js';
import { isNodeError } from '../../lib/process/errors.js';
import { error } from '../../utils/error.js';

const STALE_LOCK_MS = 60_000;

interface LockPayload {
  pid: number;
  startedAt: number;
}

function readLockPayload(lockPath: string): LockPayload | null {
  try {
    return JSON.parse(readFileSync(lockPath, 'utf-8'));
  } catch {
    return null;
  }
}

function writeLockPayload(lockPath: string): void {
  const payload: LockPayload = { pid: process.pid, startedAt: Date.now() };
  writeFileSync(lockPath, JSON.stringify(payload));
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function acquireSnapshotLock(
  projectDir: string,
  sessionId: string,
): Promise<() => Promise<void>> {
  const lockPath = snapshotLockPath(projectDir, sessionId);
  const dir = snapshotsDir(projectDir, sessionId);
  ensureSecureDir(dir);

  const tryAcquire = (isRetry: boolean): void => {
    try {
      const fd = openSync(lockPath, 'wx');
      closeSync(fd);
      writeLockPayload(lockPath);
    } catch (err: unknown) {
      if (isNodeError(err) && err.code === 'EEXIST') {
        if (!isRetry) {
          let mtime: number;
          try {
            mtime = statSync(lockPath).mtimeMs;
          } catch {
            throw error(
              'snapshot-lock-busy',
              'Another snapshot operation is in progress for this session.',
            );
          }
          if (Date.now() - mtime > STALE_LOCK_MS) {
            const payload = readLockPayload(lockPath);
            if (payload !== null && isProcessAlive(payload.pid)) {
              throw error(
                'snapshot-lock-busy',
                'Another snapshot operation is in progress for this session.',
              );
            }
            try {
              unlinkSync(lockPath);
            } catch {
              // Already removed by another process
            }
            tryAcquire(true);
            return;
          }
        }
        throw error(
          'snapshot-lock-busy',
          'Another snapshot operation is in progress for this session.',
        );
      }
      throw err;
    }
  };

  tryAcquire(false);

  return async () => {
    try {
      unlinkSync(lockPath);
    } catch {
      // Already removed
    }
  };
}
