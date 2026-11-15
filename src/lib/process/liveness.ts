import { hasErrnoCode } from '../../utils/errno.js';
import { readProcessStartTimeMs } from './start-time.js';

const PROCESS_START_TOLERANCE_MS = 2000;

export type ProcessIdentityStatus = 'live' | 'dead' | 'pid-reused' | 'unknown';

// EPERM means the process exists but belongs to another user, which is still alive for the
// purposes of every caller here.
export function canSignalProcess(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return hasErrnoCode(err, 'EPERM');
  }
}

export function probePid(pid: number): 'dead' | 'unknown' {
  try {
    process.kill(pid, 0);
    return 'unknown';
  } catch (err) {
    return hasErrnoCode(err, 'ESRCH') ? 'dead' : 'unknown';
  }
}

export function startTimeMatches(actualMs: number, expectedMs: number): boolean {
  return Math.abs(actualMs - expectedMs) <= PROCESS_START_TOLERANCE_MS;
}

export function checkProcessIdentity(
  pid: number,
  expectedStartTimeMs: number,
): ProcessIdentityStatus {
  const actualStartTimeMs = readProcessStartTimeMs(pid);
  if (actualStartTimeMs !== null && Number.isFinite(expectedStartTimeMs)) {
    return startTimeMatches(actualStartTimeMs, expectedStartTimeMs) ? 'live' : 'pid-reused';
  }

  return probePid(pid);
}
