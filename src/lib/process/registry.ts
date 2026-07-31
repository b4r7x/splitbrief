import type { ChildProcess } from 'node:child_process';
import { warnError } from '../warn.js';
import { isNodeError, processError, type ProcessTerminationTarget } from './errors.js';
import { readProcessStartTimeMs } from './start-time.js';

const SIGKILL_DELAY_MS = 2000;
const REAP_POLL_MS = 10;
const SIGNAL_DISAPPEARANCE_TIMEOUT_MS = 1000;
const SIGKILL_REAP_TIMEOUT_MS = 1000;
type ProcessLedger = {
  record(pid: number, startTimeMs: number | null): void;
  release(pid: number): void;
};

type RegisteredProcess = {
  proc: ChildProcess;
  pid: number | undefined;
  group: boolean;
  ledger: ProcessLedger | null;
  ledgered: boolean;
  releaseMonitor: NodeJS.Timeout | undefined;
};

const activeProcesses = new Map<ChildProcess, RegisteredProcess>();
const processTerminations = new WeakMap<ChildProcess, Promise<void>>();
let processLedger: ProcessLedger | null = null;
let allProcessesCleanup: Promise<void> | null = null;

/**
 * Node's detached/process-group signalling is POSIX-only in this subsystem.
 * Windows must not silently fall back to leader-only termination: that would
 * let a descendant survive while callers report cleanup as complete.
 */
export function processTreeReapingLimitation(
  signal: NodeJS.Signals | null = null,
): ReturnType<typeof processError.platformLimitation> {
  return processError.platformLimitation({
    operation: 'verify-absence',
    target: 'process-group',
    signal,
  });
}

export function setProcessLedger(ledger: ProcessLedger | null): void {
  processLedger = ledger;
}

export function clearProcessLedger(ledger: ProcessLedger): void {
  if (processLedger === ledger) processLedger = null;
}

function groupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (err) {
    if (isNodeError(err) && err.code === 'ESRCH') return false;
    if (isNodeError(err) && err.code === 'EPERM') return true;
    throw err;
  }
}

function usesProcessGroup(group: boolean, pid: number | undefined): pid is number {
  return group && pid !== undefined && pid > 1;
}

function registeredTargetIsAbsent(entry: RegisteredProcess): boolean {
  if (usesProcessGroup(entry.group, entry.pid)) return !groupExists(entry.pid);
  return entry.proc.exitCode !== null || entry.proc.signalCode !== null;
}

function releaseRegistration(entry: RegisteredProcess): void {
  if (activeProcesses.get(entry.proc) !== entry) return;
  activeProcesses.delete(entry.proc);
  if (entry.releaseMonitor !== undefined) clearInterval(entry.releaseMonitor);
  if (!entry.ledgered || entry.ledger === null || entry.pid === undefined) return;
  try {
    entry.ledger.release(entry.pid);
  } catch (err) {
    warnError('process ledger: failed to release runner pid', err);
  }
}

function monitorGroupRelease(entry: RegisteredProcess): void {
  if (!usesProcessGroup(entry.group, entry.pid) || entry.releaseMonitor !== undefined) return;
  const pid = entry.pid;
  entry.releaseMonitor = setInterval(() => {
    try {
      if (!groupExists(pid)) releaseRegistration(entry);
    } catch (err) {
      warnError('process ledger: failed to check runner process group', err);
    }
  }, REAP_POLL_MS);
  entry.releaseMonitor.unref?.();
}

export function registerProcess(
  proc: ChildProcess,
  options?: { group?: boolean | undefined; ledger?: boolean | undefined },
): void {
  const group = options?.group ?? false;
  const ledgered = group && (options?.ledger ?? true);
  const ledger = ledgered ? processLedger : null;
  const entry: RegisteredProcess = {
    proc,
    pid: proc.pid,
    group,
    ledger,
    ledgered,
    releaseMonitor: undefined,
  };
  activeProcesses.set(proc, entry);
  if (ledger !== null && entry.pid !== undefined) {
    try {
      ledger.record(entry.pid, readProcessStartTimeMs(entry.pid));
    } catch (err) {
      warnError('process ledger: failed to record runner pid', err);
    }
  }
}

export function unregisterProcess(proc: ChildProcess): void {
  const entry = activeProcesses.get(proc);
  if (entry === undefined) return;
  if (!usesProcessGroup(entry.group, entry.pid)) {
    releaseRegistration(entry);
    return;
  }
  try {
    if (!groupExists(entry.pid)) {
      releaseRegistration(entry);
      return;
    }
  } catch (err) {
    warnError('process ledger: failed to check runner process group', err);
  }
  monitorGroupRelease(entry);
}

function waitForCondition(condition: () => boolean, timeoutMs: number): Promise<boolean> {
  if (condition()) return Promise.resolve(true);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearInterval(interval);
      clearTimeout(timeout);
      resolve(value);
    };
    const check = () => {
      try {
        if (condition()) finish(true);
      } catch (err) {
        if (settled) return;
        settled = true;
        clearInterval(interval);
        clearTimeout(timeout);
        reject(err);
      }
    };
    const interval = setInterval(check, REAP_POLL_MS);
    const timeout = setTimeout(() => {
      try {
        finish(condition());
      } catch (err) {
        settled = true;
        clearInterval(interval);
        reject(err);
      }
    }, timeoutMs);
  });
}

async function sendSignal(
  proc: ChildProcess,
  pid: number | undefined,
  group: boolean,
  signal: NodeJS.Signals,
  isAbsent: () => boolean,
): Promise<void> {
  const target = usesProcessGroup(group, pid) ? 'process-group' : 'process';
  let signalError: unknown;
  try {
    const sent = usesProcessGroup(group, pid) ? process.kill(-pid, signal) : proc.kill(signal);
    if (sent) return;
  } catch (err) {
    signalError = err;
  }
  if (verifiedAbsent(isAbsent, target, signal)) return;
  if (await waitUntilAbsent(isAbsent, SIGNAL_DISAPPEARANCE_TIMEOUT_MS, target, signal)) return;
  throw processError.platformLimitation({ operation: 'signal', target, signal }, signalError);
}

function verifiedAbsent(
  isAbsent: () => boolean,
  target: ProcessTerminationTarget,
  signal: NodeJS.Signals | null,
): boolean {
  try {
    return isAbsent();
  } catch (err) {
    throw processError.platformLimitation({ operation: 'verify-absence', target, signal }, err);
  }
}

async function waitUntilAbsent(
  isAbsent: () => boolean,
  timeoutMs: number,
  target: ProcessTerminationTarget,
  signal: NodeJS.Signals,
): Promise<boolean> {
  try {
    return await waitForCondition(isAbsent, timeoutMs);
  } catch (err) {
    throw processError.platformLimitation({ operation: 'verify-absence', target, signal }, err);
  }
}

async function terminateProcess(
  proc: ChildProcess,
  options: { group: boolean; pid: number | undefined },
): Promise<void> {
  const groupPid = usesProcessGroup(options.group, options.pid) ? options.pid : null;
  const useGroup = groupPid !== null;
  const target = useGroup ? 'process-group' : 'process';
  const isAbsent =
    groupPid !== null
      ? () => !groupExists(groupPid)
      : () => proc.exitCode !== null || proc.signalCode !== null;

  if (verifiedAbsent(isAbsent, target, null)) return;
  await sendSignal(proc, options.pid, useGroup, 'SIGTERM', isAbsent);

  if (await waitUntilAbsent(isAbsent, SIGKILL_DELAY_MS, target, 'SIGTERM')) return;

  await sendSignal(proc, options.pid, useGroup, 'SIGKILL', isAbsent);

  if (!(await waitUntilAbsent(isAbsent, SIGKILL_REAP_TIMEOUT_MS, target, 'SIGKILL'))) {
    throw processError.platformLimitation({
      operation: 'verify-absence',
      target,
      signal: 'SIGKILL',
    });
  }
}

export function killProcess(proc: ChildProcess, options?: { group?: boolean }): Promise<void> {
  const current = processTerminations.get(proc);
  if (current !== undefined) return current;

  if (process.platform === 'win32') {
    const limitation = Promise.reject(processTreeReapingLimitation());
    processTerminations.set(proc, limitation);
    const clearTermination = () => {
      if (processTerminations.get(proc) === limitation) processTerminations.delete(proc);
    };
    limitation.then(clearTermination, clearTermination);
    return limitation;
  }

  const entry = activeProcesses.get(proc);
  const group = options?.group ?? entry?.group ?? false;
  const pid = entry?.pid ?? proc.pid;
  const termination = terminateProcess(proc, { group, pid }).finally(() => {
    processTerminations.delete(proc);
    if (entry === undefined) return;
    try {
      if (registeredTargetIsAbsent(entry)) releaseRegistration(entry);
    } catch (err) {
      warnError('process ledger: failed to check registered process absence', err);
    }
  });
  processTerminations.set(proc, termination);
  return termination;
}

export function abortProcess(
  proc: ChildProcess,
  signal: AbortSignal,
  options?: { group?: boolean },
): Promise<void> {
  const group = options?.group ?? false;
  const pid = activeProcesses.get(proc)?.pid ?? proc.pid;
  if (signal.aborted) {
    if (process.platform === 'win32') return Promise.reject(processTreeReapingLimitation());
    return killProcess(proc, { group });
  }
  if (!usesProcessGroup(group, pid) && proc.exitCode !== null) return Promise.resolve();

  return new Promise((resolve, reject) => {
    let releasePoll: NodeJS.Timeout | undefined;
    const cleanup = () => {
      signal.removeEventListener('abort', onAbort);
      proc.removeListener('close', onClose);
      if (releasePoll !== undefined) clearInterval(releasePoll);
    };
    const finish = () => {
      cleanup();
      resolve();
    };
    const fail = (err: unknown) => {
      cleanup();
      reject(err);
    };
    const onAbort = () => {
      if (process.platform === 'win32') {
        fail(processTreeReapingLimitation());
        return;
      }
      void killProcess(proc, { group }).then(finish, fail);
    };
    const onClose = () => {
      if (!usesProcessGroup(group, pid)) {
        finish();
        return;
      }
      try {
        if (!groupExists(pid)) {
          finish();
          return;
        }
      } catch (err) {
        fail(
          processError.platformLimitation(
            {
              operation: 'verify-absence',
              target: 'process-group',
              signal: null,
            },
            err,
          ),
        );
        return;
      }
      releasePoll = setInterval(() => {
        try {
          if (!groupExists(pid)) finish();
        } catch (err) {
          fail(
            processError.platformLimitation(
              {
                operation: 'verify-absence',
                target: 'process-group',
                signal: null,
              },
              err,
            ),
          );
        }
      }, REAP_POLL_MS);
    };

    signal.addEventListener('abort', onAbort, { once: true });
    proc.once('close', onClose);
    if (signal.aborted) onAbort();
  });
}

async function cleanupRegisteredProcesses(): Promise<void> {
  while (activeProcesses.size > 0) {
    const entries = [...activeProcesses.values()];
    await Promise.all(entries.map((entry) => killProcess(entry.proc, { group: entry.group })));
  }
}

export function killAllProcesses(): Promise<void> {
  if (allProcessesCleanup !== null) return allProcessesCleanup;
  const cleanup = cleanupRegisteredProcesses();
  allProcessesCleanup = cleanup;
  cleanup.then(
    () => {
      if (allProcessesCleanup === cleanup) allProcessesCleanup = null;
    },
    () => {
      if (allProcessesCleanup === cleanup) allProcessesCleanup = null;
    },
  );
  return cleanup;
}
