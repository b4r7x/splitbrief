import type { ChildProcess } from 'node:child_process';
import { hasErrnoCode } from '../../utils/errno.js';
import { processError, type ProcessTerminationTarget } from './errors.js';

export const SIGKILL_DELAY_MS = 2000;
export const REAP_POLL_MS = 10;
const SIGNAL_DISAPPEARANCE_TIMEOUT_MS = 1000;
const SIGKILL_REAP_TIMEOUT_MS = 1000;

export function groupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (err) {
    if (hasErrnoCode(err, 'ESRCH')) return false;
    if (hasErrnoCode(err, 'EPERM')) return true;
    throw err;
  }
}

export function usesProcessGroup(group: boolean, pid: number | undefined): pid is number {
  return group && pid !== undefined && pid > 1;
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

export async function terminateProcess(
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
