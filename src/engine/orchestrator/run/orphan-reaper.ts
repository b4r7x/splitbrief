import { sessionDir } from '../../../core/paths.js';
import { tryClaimSession } from '../../../core/sessions/lock/ownership.js';
import { checkSessionLockStatus } from '../../../core/sessions/lock/status.js';
import { listSessionIds, sessionsRootLabel } from '../../../core/sessions/orphans.js';
import { sessionRelativePath } from '../../../core/sessions/ownership-marker.js';
import {
  RUNNER_PIDS_FILE,
  readRunnerPids,
  releaseRunnerPids,
  type RunnerPidEntry,
} from '../../../core/sessions/runner-pids.js';
import { canSignalProcess, startTimeMatches } from '../../../lib/process/liveness.js';
import { readProcessStartTimeMs as defaultReadProcessStartTimeMs } from '../../../lib/process/start-time.js';
import { warnError } from '../../../lib/warn.js';

const SIGKILL_GRACE_MS = 2000;

export type OrphanReaperDeps = {
  readProcessStartTimeMs: (pid: number) => number | null;
};

const defaultDeps: OrphanReaperDeps = {
  readProcessStartTimeMs: defaultReadProcessStartTimeMs,
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  return !startTimeMatches(actualStartTimeMs, recordedStartTimeMs);
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

export async function reapSessionOrphans(
  projectDir: string,
  sessionId: string,
  deps: OrphanReaperDeps = defaultDeps,
): Promise<void> {
  const ref = { projectDir, sessionId };
  let release: (() => void) | null = null;
  try {
    if (readRunnerPids(ref).length === 0) return;
    release = tryClaimSession(ref);
    if (release === null || !sessionOwnerGone(sessionDir(projectDir, sessionId), sessionId)) return;
    const pids = readRunnerPids(ref);
    await Promise.all(pids.map((entry) => reapOrphanPid(entry, deps)));
    try {
      releaseRunnerPids(ref, pids);
    } catch (err) {
      warnError(
        `Checked the tool processes the stopped run in ${sessionRelativePath(sessionId)} left, but could not update ${sessionRelativePath(sessionId, RUNNER_PIDS_FILE)}, so the next start checks them again`,
        err,
      );
    }
  } catch (err) {
    warnError(
      `Could not check ${sessionRelativePath(sessionId)} for tool processes its stopped run left, so they may keep running`,
      err,
    );
  } finally {
    release?.();
  }
}

export async function reapOrphanRunners(
  projectDir: string,
  deps: OrphanReaperDeps = defaultDeps,
): Promise<void> {
  let sessionIds: string[];
  try {
    sessionIds = listSessionIds(projectDir);
  } catch (err) {
    warnError(
      `Could not list ${sessionsRootLabel(projectDir)}, so tool processes that stopped runs left may keep running`,
      err,
    );
    return;
  }
  await Promise.all(sessionIds.map((sessionId) => reapSessionOrphans(projectDir, sessionId, deps)));
}
