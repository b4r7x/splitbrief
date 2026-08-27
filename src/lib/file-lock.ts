import {
  openSync,
  closeSync,
  unlinkSync,
  readFileSync,
  writeSync,
  renameSync,
  linkSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname } from 'node:path';
import { ensureSecureDir } from './fs.js';
import { canSignalProcess } from './process/liveness.js';

const LOCK_SUFFIX = '.lock';
const LOCK_MAX_ATTEMPTS = 100;
const LOCK_SLEEP_MS = 5;
const LOCK_STALE_MS = 30_000;

type LockHolder = { pid: number; acquiredAt: number };

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function contentsAreStale(raw: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return true;
  }
  if (parsed === null || typeof parsed !== 'object') return true;
  const { pid, acquiredAt } = parsed as { pid?: unknown; acquiredAt?: unknown };
  if (typeof pid !== 'number' || typeof acquiredAt !== 'number') return true;
  if (!canSignalProcess(pid)) return true;
  return Date.now() - acquiredAt > LOCK_STALE_MS;
}

// Reclaim a lock observed as stale without a TOCTOU window: atomically rename it
// to a unique sidecar (only one acquirer can win the rename), then verify the
// renamed bytes are exactly the stale holder we inspected. If a fresh holder
// slipped in between the staleness read and the rename, the bytes differ — we
// restore the file and back off rather than deleting an active lock. Returns
// true only when this acquirer removed the stale holder and the path is free.
function reclaimStaleLock(lockPath: string): boolean {
  let raw: string;
  try {
    raw = readFileSync(lockPath, 'utf-8');
  } catch {
    // Holder vanished (or is unreadable); let the next openSync('wx') decide.
    return false;
  }
  if (!contentsAreStale(raw)) return false;

  const sidecar = `${lockPath}.stale.${process.pid}.${randomBytes(6).toString('hex')}`;
  try {
    renameSync(lockPath, sidecar);
  } catch {
    // Another acquirer reclaimed it first, or the holder removed it: retry.
    return false;
  }

  let claimed: string;
  try {
    claimed = readFileSync(sidecar, 'utf-8');
  } catch {
    // We moved it but can no longer read it; treat the path as free.
    return true;
  }
  if (claimed === raw) {
    try {
      unlinkSync(sidecar);
    } catch {
      // best-effort cleanup; the path is already free
    }
    return true;
  }

  // A fresh holder replaced the stale lock after our staleness read — restore it.
  // linkSync (not renameSync): the path is free in this window, so a third
  // acquirer may already hold lockPath via openSync('wx') and be running fn().
  // linkSync fails with EEXIST instead of atomically clobbering that live lock,
  // so the captured bytes are restored only while the path is still free.
  try {
    linkSync(sidecar, lockPath);
  } catch {
    // A third acquirer holds lockPath (EEXIST) or the link failed: leave it be.
  }
  try {
    unlinkSync(sidecar);
  } catch {
    // best-effort cleanup
  }
  return false;
}

export function lockSibling(filePath: string): string {
  return `${filePath}${LOCK_SUFFIX}`;
}

export function withFileLock<T>(lockPath: string, onTimeout: () => Error, fn: () => T): T {
  ensureSecureDir(dirname(lockPath));
  for (let attempt = 0; attempt < LOCK_MAX_ATTEMPTS; attempt++) {
    let fd: number;
    try {
      fd = openSync(lockPath, 'wx');
    } catch (err: unknown) {
      const code = err && typeof err === 'object' && 'code' in err ? err.code : undefined;
      if (code !== 'EEXIST') throw err;
      if (reclaimStaleLock(lockPath)) continue;
      sleepSync(LOCK_SLEEP_MS);
      continue;
    }
    try {
      const holder: LockHolder = { pid: process.pid, acquiredAt: Date.now() };
      writeSync(fd, JSON.stringify(holder));
    } finally {
      closeSync(fd);
    }
    try {
      return fn();
    } finally {
      try {
        unlinkSync(lockPath);
      } catch {
        // best-effort unlock
      }
    }
  }
  throw onTimeout();
}
