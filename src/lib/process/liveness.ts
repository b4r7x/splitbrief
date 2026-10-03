import { execFileSync } from 'node:child_process';
import { isNodeError } from './errors.js';

// EPERM means the process exists but belongs to another user, which is still alive for the
// purposes of every caller here.
export function canSignalProcess(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return isNodeError(err) && err.code === 'EPERM';
  }
}

/**
 * Whether `pid` still has a running child. macOS and Linux share
 * `ps -A -o ppid=,stat=`, which lists every process as `<ppid> <stat>` with the
 * headers suppressed, so one scan works on both platforms. A `stat` starting
 * with `Z` marks a zombie: the child exited and its parent has not reaped it,
 * so it is not running. A process with a live descendant has a live direct
 * child — an orphan reparents away from the tree, never under the leader — so
 * the direct child is the whole check.
 *
 * A call that cannot read the process table is reported as having children:
 * that keeps the no-progress cut from firing on evidence it could not check.
 */
export function hasLiveDescendants(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;

  let table: string;
  try {
    table = execFileSync('ps', ['-A', '-o', 'ppid=,stat='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return true;
  }

  for (const line of table.split('\n')) {
    const [parentText, stat] = line.trim().split(/\s+/);
    if (stat === undefined || stat.startsWith('Z')) continue;
    if (Number.parseInt(parentText ?? '', 10) === pid) return true;
  }
  return false;
}
