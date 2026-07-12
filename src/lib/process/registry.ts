import type { ChildProcess } from 'node:child_process';
import { warnError } from '../warn.js';
import { isNodeError } from './errors.js';
import { readProcessStartTimeMs } from './start-time.js';

const SIGKILL_DELAY = 2000;
const ABORT_KILL_DELAY = 2000;

type RegisteredProcess = {
  proc: ChildProcess;
  group: boolean;
  ledgered: boolean;
};

type ProcessLedger = {
  record(pid: number, startTimeMs: number | null): void;
  release(pid: number): void;
};

const activeProcesses = new Map<ChildProcess, RegisteredProcess>();
let processLedger: ProcessLedger | null = null;

// src/lib/ stays session-agnostic; the engine installs a session-bound ledger via setProcessLedger.
export function setProcessLedger(ledger: ProcessLedger | null): void {
  processLedger = ledger;
}

// Ownership-guarded uninstall: a superseded run's late teardown must not null a
// ledger a successor run has already installed — last-write-wins here would
// silently disable runner-pid recording for the rest of the successor run.
export function clearProcessLedger(ledger: ProcessLedger): void {
  if (processLedger === ledger) processLedger = null;
}

export function registerProcess(
  proc: ChildProcess,
  options?: { group?: boolean | undefined; ledger?: boolean | undefined },
): void {
  const group = options?.group ?? false;
  // Ledger recording costs a synchronous `ps` exec plus a jsonl rewrite per
  // spawn; short-lived commands (git, probes, validation) opt out with
  // ledger: false so only long-lived runner spawns pay it.
  const ledgered = group && (options?.ledger ?? true);
  activeProcesses.set(proc, { proc, group, ledgered });
  if (ledgered && processLedger && proc.pid !== undefined) {
    // The ledger is best-effort crash-recovery bookkeeping: a failed write must
    // not reject the runner call that just spawned this process.
    try {
      processLedger.record(proc.pid, readProcessStartTimeMs(proc.pid));
    } catch (err) {
      warnError('process ledger: failed to record runner pid', err);
    }
  }
}

export function unregisterProcess(proc: ChildProcess): void {
  const entry = activeProcesses.get(proc);
  activeProcesses.delete(proc);
  if (entry?.ledgered && processLedger && proc.pid !== undefined) {
    // Called from process 'close'/'error' handlers with no catcher above: a
    // failed ledger release (ENOSPC, EACCES, planted symlink) must not become
    // an uncaughtException that tears down the app.
    try {
      processLedger.release(proc.pid);
    } catch (err) {
      warnError('process ledger: failed to release runner pid', err);
    }
  }
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
        warnError('killProcess: SIGKILL escalation failed', err);
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
  for (const entry of activeProcesses.values()) {
    killProcess(entry.proc, { group: entry.group });
  }
}
