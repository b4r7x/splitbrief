import type { ChildProcess } from 'node:child_process';
import { isNodeError } from './process-errors.js';

const SIGKILL_DELAY = 5000;

const activeProcesses = new Set<ChildProcess>();

export function registerProcess(proc: ChildProcess): void {
  activeProcesses.add(proc);
}

export function unregisterProcess(proc: ChildProcess): void {
  activeProcesses.delete(proc);
}

export function getActiveProcessCount(): number {
  return activeProcesses.size;
}

export function killProcess(proc: ChildProcess, options?: { group?: boolean }): void {
  if (proc.exitCode !== null || proc.killed) return;
  const useGroup = options?.group && proc.pid !== undefined;
  try {
    if (useGroup) {
      process.kill(-proc.pid!, 'SIGTERM');
    } else {
      proc.kill('SIGTERM');
    }
  } catch (err) {
    if (!(isNodeError(err) && err.code === 'ESRCH')) {
      throw err;
    }
  }
  setTimeout(() => {
    if (proc.pid === undefined) return;
    try {
      process.kill(useGroup ? -proc.pid! : proc.pid, 0);
      if (useGroup) {
        process.kill(-proc.pid!, 'SIGKILL');
      } else {
        proc.kill('SIGKILL');
      }
    } catch (err) {
      if (!(isNodeError(err) && err.code === 'ESRCH')) {
        throw err;
      }
    }
  }, SIGKILL_DELAY);
}

export function killAllProcesses(): void {
  for (const proc of activeProcesses) {
    killProcess(proc);
  }
}
