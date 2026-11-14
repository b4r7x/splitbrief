import { hasErrnoCode } from '../../utils/errno.js';

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
