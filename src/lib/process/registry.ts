import type { ChildProcess } from 'node:child_process';
import { isNodeError } from './errors.js';

const SIGKILL_DELAY = 2000;
const ABORT_KILL_DELAY = 2000;

const activeProcesses = new Set<ChildProcess>();

export function registerProcess(proc: ChildProcess): void {
  activeProcesses.add(proc);
}

export function unregisterProcess(proc: ChildProcess): void {
  activeProcesses.delete(proc);
}

export function killProcess(
  proc: ChildProcess,
  options?: { group?: boolean; killDelay?: number },
): void {
  if (proc.exitCode !== null || proc.killed) return;
  const pid = proc.pid;
  const useGroup = options?.group && pid !== undefined;
  const delay = options?.killDelay ?? SIGKILL_DELAY;
  try {
    if (useGroup && pid !== undefined) {
      process.kill(-pid, 'SIGTERM');
    } else {
      proc.kill('SIGTERM');
    }
  } catch (err) {
    if (!(isNodeError(err) && err.code === 'ESRCH')) {
      throw err;
    }
  }
  const escalationTimer = setTimeout(() => {
    const currentPid = proc.pid;
    if (currentPid === undefined) return;
    try {
      process.kill(useGroup ? -currentPid : currentPid, 0);
      if (useGroup) {
        process.kill(-currentPid, 'SIGKILL');
      } else {
        proc.kill('SIGKILL');
      }
    } catch (err) {
      if (!(isNodeError(err) && err.code === 'ESRCH')) {
        throw err;
      }
    }
  }, delay);
  escalationTimer.unref?.();
  proc.once('close', () => clearTimeout(escalationTimer));
}

export function abortProcess(
  proc: ChildProcess,
  signal: AbortSignal,
  options?: { group?: boolean },
): void {
  if (proc.exitCode !== null || proc.killed) return;

  const onAbort = () =>
    killProcess(proc, { group: options?.group ?? false, killDelay: ABORT_KILL_DELAY });

  if (signal.aborted) {
    onAbort();
    return;
  }

  signal.addEventListener('abort', onAbort, { once: true });
  proc.on('close', () => signal.removeEventListener('abort', onAbort));
}

export function killAllProcesses(): void {
  for (const proc of activeProcesses) {
    killProcess(proc);
  }
}
