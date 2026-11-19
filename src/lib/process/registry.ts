import { AsyncLocalStorage } from 'node:async_hooks';
import type { ChildProcess } from 'node:child_process';
import { warnError } from '../warn.js';
import { processError } from './errors.js';
import { readProcessStartTimeMs } from './start-time.js';
import { REAP_POLL_MS, groupExists, terminateProcess, usesProcessGroup } from './termination.js';
import { unwatchGroup, watchGroup } from './parent-watchdog.js';

export type ProcessLedger = {
  record(pid: number, startTimeMs: number | null): void;
  release(pid: number): void;
};

/**
 * One run's processes. Every process registered while work started in the scope runs belongs to
 * it, so stopping or ending the run ends its own processes and leaves the rest, such as a model
 * list loading in Settings, running.
 */
export type ProcessScope = symbol;

type RegisteredProcess = {
  proc: ChildProcess;
  pid: number | undefined;
  group: boolean;
  ledger: ProcessLedger | null;
  releaseMonitor: NodeJS.Timeout | undefined;
  scope: ProcessScope | undefined;
};

const runningScope = new AsyncLocalStorage<ProcessScope | undefined>();
const activeProcesses = new Map<ChildProcess, RegisteredProcess>();
const processTerminations = new WeakMap<ChildProcess, Promise<void>>();
const processLedgers = new Map<ProcessScope | undefined, ProcessLedger>();
let allProcessesCleanup: Promise<void> | null = null;
const registryListeners = new Set<(count: number) => void>();

export function onProcessRegistryChange(listener: (count: number) => void): () => void {
  registryListeners.add(listener);
  return () => {
    registryListeners.delete(listener);
  };
}

export function registeredProcessCount(): number {
  return activeProcesses.size;
}

function notifyRegistryChange(): void {
  for (const listener of registryListeners) listener(activeProcesses.size);
}

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

export function createProcessScope(): ProcessScope {
  return Symbol('process scope');
}

/** Runs `fn` in `scope`: a process it registers, directly or after an await, belongs to the scope. */
export function runInProcessScope<T>(scope: ProcessScope, fn: () => T): T {
  return runningScope.run(scope, fn);
}

/** Runs `fn` in no scope: a process it registers belongs to no run, whichever run's work called it. */
export function runOutsideProcessScope<T>(fn: () => T): T {
  return runningScope.run(undefined, fn);
}

/** The scope the calling work runs in, or undefined when it belongs to no run. */
export function currentProcessScope(): ProcessScope | undefined {
  return runningScope.getStore();
}

export function processScopeCount(scope: ProcessScope): number {
  let count = 0;
  for (const entry of activeProcesses.values()) if (entry.scope === scope) count++;
  return count;
}

export function setProcessLedger(ledger: ProcessLedger | null): void {
  const scope = currentProcessScope();
  if (ledger === null) processLedgers.delete(scope);
  else processLedgers.set(scope, ledger);
}

export function clearProcessLedger(ledger: ProcessLedger): void {
  const scope = currentProcessScope();
  if (processLedgers.get(scope) === ledger) processLedgers.delete(scope);
}

function registeredTargetIsAbsent(entry: RegisteredProcess): boolean {
  if (usesProcessGroup(entry.group, entry.pid)) return !groupExists(entry.pid);
  return entry.proc.exitCode !== null || entry.proc.signalCode !== null;
}

function releaseRegistration(entry: RegisteredProcess): void {
  if (activeProcesses.get(entry.proc) !== entry) return;
  activeProcesses.delete(entry.proc);
  notifyRegistryChange();
  if (entry.releaseMonitor !== undefined) clearInterval(entry.releaseMonitor);
  if (usesProcessGroup(entry.group, entry.pid)) unwatchGroup(entry.pid);
  if (entry.ledger === null || entry.pid === undefined) return;
  try {
    entry.ledger.release(entry.pid);
  } catch (err) {
    warnError('Could not remove an ended tool process from the record of tool processes', err);
  }
}

function monitorGroupRelease(entry: RegisteredProcess): void {
  if (!usesProcessGroup(entry.group, entry.pid) || entry.releaseMonitor !== undefined) return;
  const pid = entry.pid;
  entry.releaseMonitor = setInterval(() => {
    try {
      if (!groupExists(pid)) releaseRegistration(entry);
    } catch (err) {
      warnError('Could not check whether a tool process ended', err);
    }
  }, REAP_POLL_MS);
  entry.releaseMonitor.unref?.();
}

export function registerProcess(
  proc: ChildProcess,
  options?: { group?: boolean | undefined },
): void {
  const group = options?.group ?? false;
  const scope = currentProcessScope();
  const ledger = group ? (processLedgers.get(scope) ?? null) : null;
  const entry: RegisteredProcess = {
    proc,
    pid: proc.pid,
    group,
    ledger,
    releaseMonitor: undefined,
    scope,
  };
  activeProcesses.set(proc, entry);
  notifyRegistryChange();
  if (usesProcessGroup(group, entry.pid)) watchGroup(entry.pid);
  if (ledger !== null && entry.pid !== undefined) {
    try {
      ledger.record(entry.pid, readProcessStartTimeMs(entry.pid));
    } catch (err) {
      warnError(
        'Could not add a started tool process to the record of tool processes, so a later run cannot stop it if SPLITBRIEF exits early',
        err,
      );
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
    warnError('Could not check whether a tool process ended', err);
  }
  monitorGroupRelease(entry);
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
      warnError('Could not check whether a tool process ended', err);
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
  const terminate = () =>
    process.platform === 'win32'
      ? Promise.reject(processTreeReapingLimitation())
      : killProcess(proc, { group: options?.group ?? false });
  if (signal.aborted) return terminate();
  return new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => void terminate().then(resolve, reject), { once: true });
  });
}

async function killRegisteredProcesses(
  owned: (entry: RegisteredProcess) => boolean,
): Promise<void> {
  for (;;) {
    const entries = [...activeProcesses.values()].filter(owned);
    if (entries.length === 0) return;
    await Promise.all(entries.map((entry) => killProcess(entry.proc, { group: entry.group })));
  }
}

/** Ends the processes of one run and waits until they are gone. */
export function killProcessScope(scope: ProcessScope): Promise<void> {
  return killRegisteredProcesses((entry) => entry.scope === scope);
}

/** Ends every registered process. Only the shutdown of SPLITBRIEF itself calls it. */
export function killAllProcesses(): Promise<void> {
  if (allProcessesCleanup !== null) return allProcessesCleanup;
  const cleanup = killRegisteredProcesses(() => true);
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
