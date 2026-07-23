import { existsSync, readdirSync } from 'node:fs';
import { isValidSessionId, sessionDir, sessionsRoot } from '../../../core/paths.js';
import { checkSessionLockStatus } from '../../../core/sessions/lockfile-status.js';
import {
  readRunnerPids,
  releaseRunnerPids,
  type RunnerPidEntry,
} from '../../../core/sessions/runner-pids.js';
import { isNodeError } from '../../../lib/process/errors.js';
import { readProcessStartTimeMs as defaultReadProcessStartTimeMs } from '../../../lib/process/start-time.js';
import { warnError } from '../../../lib/warn.js';

const SIGKILL_GRACE_MS = 2000;
const START_TIME_TOLERANCE_MS = 2000;

export type OrphanReaperDeps = {
  readProcessStartTimeMs: (pid: number) => number | null;
};

const defaultDeps: OrphanReaperDeps = {
  readProcessStartTimeMs: defaultReadProcessStartTimeMs,
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function canSignalProcess(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return isNodeError(err) && err.code === 'EPERM';
  }
}

function canSignalGroup(pid: number): boolean {
  return canSignalProcess(-pid);
}

function sendGroupSignal(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
    return;
  } catch {
    // no such process group — fall back to signaling the pid directly
  }
  try {
    process.kill(pid, signal);
  } catch {
    // process already gone
  }
}

function pidWasRecycled(pid: number, recordedStartTimeMs: number, deps: OrphanReaperDeps): boolean {
  const actualStartTimeMs = deps.readProcessStartTimeMs(pid);
  if (actualStartTimeMs === null) return true;
  return Math.abs(actualStartTimeMs - recordedStartTimeMs) > START_TIME_TOLERANCE_MS;
}

async function reapOrphanPid(entry: RunnerPidEntry, deps: OrphanReaperDeps): Promise<void> {
  if (entry.pid <= 1 || entry.startTimeMs === null) return;
  if (pidWasRecycled(entry.pid, entry.startTimeMs, deps)) return;
  if (!canSignalGroup(entry.pid)) return;
  sendGroupSignal(entry.pid, 'SIGTERM');
  await sleep(SIGKILL_GRACE_MS);
  if (canSignalGroup(entry.pid) && !pidWasRecycled(entry.pid, entry.startTimeMs, deps)) {
    sendGroupSignal(entry.pid, 'SIGKILL');
  }
}

function sessionOwnerGone(sessionDirPath: string, sessionId: string): boolean {
  const status = checkSessionLockStatus({
    sessionDir: sessionDirPath,
    expectedSessionId: sessionId,
  });
  return status.kind === 'dead' || status.kind === 'exited';
}

async function reapSessionOrphans(
  projectDir: string,
  sessionId: string,
  deps: OrphanReaperDeps,
): Promise<void> {
  const ref = { projectDir, sessionId };
  try {
    const pids = readRunnerPids(ref);
    if (pids.length === 0) return;

    if (!sessionOwnerGone(sessionDir(projectDir, sessionId), sessionId)) return;

    await Promise.all(pids.map((entry) => reapOrphanPid(entry, deps)));
    releaseRunnerPids(ref, pids);
  } catch (err) {
    warnError(`orphan reaper: skipping session ${sessionId}`, err);
  }
}

export async function reapOrphanRunners(
  projectDir: string,
  deps: OrphanReaperDeps = defaultDeps,
): Promise<void> {
  const root = sessionsRoot(projectDir);
  if (!existsSync(root)) return;

  let sessionIds: string[];
  try {
    sessionIds = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && isValidSessionId(entry.name))
      .map((entry) => entry.name);
  } catch (err) {
    warnError('orphan reaper: cannot list sessions', err);
    return;
  }

  await Promise.all(sessionIds.map((sessionId) => reapSessionOrphans(projectDir, sessionId, deps)));
}
