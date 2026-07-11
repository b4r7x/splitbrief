import { existsSync, readdirSync } from 'node:fs';
import { isValidSessionId, sessionDir, sessionsRoot } from '../../../core/paths.js';
import { checkSessionLockStatus } from '../../../core/sessions/lockfile-status.js';
import {
  readRunnerPids,
  releaseRunnerPids,
  type RunnerPidEntry,
} from '../../../core/sessions/runner-pids.js';
import { isNodeError } from '../../../lib/process/errors.js';
import { readProcessStartTimeMs } from '../../../lib/process/start-time.js';
import { warnError } from '../../../lib/warn.js';

const SIGKILL_GRACE_MS = 2000;
const START_TIME_TOLERANCE_MS = 2000;

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

// Probes the whole process group rather than just the recorded leader pid: the
// leader can exit during the SIGTERM grace while a runner-spawned child
// (trapping SIGTERM) survives, and that survivor still belongs to the group.
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

// A recorded start time that no longer matches the live process — or that
// cannot be read at all (e.g. a locale-dependent `ps lstart` parse failure) —
// is zero identity proof that the pid still belongs to the process diptych
// recorded, so it must not be killed.
function pidWasRecycled(pid: number, recordedStartTimeMs: number): boolean {
  const actualStartTimeMs = readProcessStartTimeMs(pid);
  if (actualStartTimeMs === null) return true;
  return Math.abs(actualStartTimeMs - recordedStartTimeMs) > START_TIME_TOLERANCE_MS;
}

async function reapOrphanPid(entry: RunnerPidEntry): Promise<void> {
  // pid 1 would turn sendGroupSignal into process.kill(-1, …) — the broadcast
  // group that signals every process the user can signal — and an entry with no
  // recorded start time has no identity proof against pid recycling. Neither
  // may ever be killed from persisted state.
  if (entry.pid <= 1 || entry.startTimeMs === null) return;
  if (pidWasRecycled(entry.pid, entry.startTimeMs)) return;
  // Nothing alive to signal — skip the SIGTERM grace sleep entirely (the
  // common post-reboot case, where the ledger pid is already dead).
  if (!canSignalGroup(entry.pid)) return;
  sendGroupSignal(entry.pid, 'SIGTERM');
  await sleep(SIGKILL_GRACE_MS);
  // Re-check identity after the grace: the group leader can die during the
  // sleep and its pid be recycled by an unrelated process before the SIGKILL.
  if (canSignalGroup(entry.pid) && !pidWasRecycled(entry.pid, entry.startTimeMs)) {
    sendGroupSignal(entry.pid, 'SIGKILL');
  }
}

// Only two lockfile kinds prove the owning diptych is gone: 'dead' (process no
// longer exists) and 'exited' (the session recorded a clean exit, so surviving
// ledger pids are genuine orphans). 'stale' is a LIVE process whose heartbeat is
// merely old — a TUI suspended with Ctrl+Z or wedged >8s — and its runners must
// not be killed. 'missing'/'invalid' cannot prove the owner is gone either: a
// live run continues after a failed lockfile write.
function sessionOwnerGone(sessionDirPath: string, sessionId: string): boolean {
  const status = checkSessionLockStatus({
    sessionDir: sessionDirPath,
    expectedSessionId: sessionId,
  });
  return status.kind === 'dead' || status.kind === 'exited';
}

// Best-effort: a session whose ledger or lockfile cannot be read must not block
// workflow startup or the reaping of the remaining sessions.
async function reapSessionOrphans(projectDir: string, sessionId: string): Promise<void> {
  const ref = { projectDir, sessionId };
  try {
    const pids = readRunnerPids(ref);
    if (pids.length === 0) return;

    if (!sessionOwnerGone(sessionDir(projectDir, sessionId), sessionId)) return;

    await Promise.all(pids.map(reapOrphanPid));
    // Release only the pids reaped from this snapshot, not the whole ledger: a
    // session resumed concurrently during the SIGKILL grace above may have
    // recorded a fresh pid that must survive.
    releaseRunnerPids(ref, pids);
  } catch (err) {
    warnError(`orphan reaper: skipping session ${sessionId}`, err);
  }
}

export async function reapOrphanRunners(projectDir: string): Promise<void> {
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

  // Sessions reap concurrently so N dead sessions share one SIGKILL grace
  // window instead of stacking N sleeps ahead of workflow startup.
  await Promise.all(sessionIds.map((sessionId) => reapSessionOrphans(projectDir, sessionId)));
}
