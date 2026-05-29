import { openSync, closeSync, unlinkSync, statSync } from 'node:fs';
import { snapshotLockPath, snapshotsDir } from '../../core/paths.js';
import { ensureSecureDir } from '../../lib/fs.js';
import { isNodeError } from '../../lib/process/errors.js';
import { error } from '../../utils/error.js';

const STALE_LOCK_MS = 60_000;

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
