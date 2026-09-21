import type { WorkflowMode } from '../../../core/schemas/enums.js';
import { SPLITBRIEF_IDENTITY } from '../../../core/identity.js';
import { sessionDir } from '../../../core/paths.js';
import { ensureSessionDir } from '../../../core/paths-io.js';
import { warnError } from '../../../lib/warn.js';
import { error } from '../../../utils/error.js';
import { startHeartbeat } from './heartbeat.js';
import {
  checkSessionLiveness,
  markExited,
  writeLockfile,
  type SessionLivenessStatus,
} from '../../../core/sessions/lockfile.js';

const workflowLivenessError = {
  sessionAlreadyLive: (sessionId: string, pid: number) =>
    error(
      'workflow-session-already-live',
      `session '${sessionId}' is already running (pid ${pid}) — stop it before resuming, or run '${SPLITBRIEF_IDENTITY.executable} continue ${sessionId}' once it has ended.`,
      { sessionId, pid },
    ),
};

// Every run writes a liveness lockfile + heartbeat so checkSessionLiveness can see an
// in-flight run and refuse a concurrent resume/continue.
export async function acquireLiveness(opts: {
  projectDir: string;
  sessionId: string;
  feature: string;
  mode: WorkflowMode;
  signal?: AbortSignal | undefined;
}): Promise<() => Promise<void>> {
  const dir = sessionDir(opts.projectDir, opts.sessionId);
  ensureSessionDir(opts.projectDir, opts.sessionId);
  let status: SessionLivenessStatus;
  try {
    status = checkSessionLiveness(dir);
  } catch (err) {
    if (opts.signal?.aborted) return async () => {};
    warnError('Failed to inspect session liveness lockfile', err);
    return async () => {};
  }
  if (status.alive) {
    throw workflowLivenessError.sessionAlreadyLive(opts.sessionId, status.data.pid);
  }

  try {
    const now = Date.now();
    await writeLockfile(dir, {
      pid: process.pid,
      startTimeMs: now,
      lastAliveMs: now,
      sessionId: opts.sessionId,
      mode: opts.mode,
      feature: opts.feature,
    });
    const stopHeartbeat = startHeartbeat(dir);
    return async () => {
      stopHeartbeat();
      try {
        await markExited(dir, 0);
      } catch (err) {
        warnError('Failed to mark session exited', err);
      }
    };
  } catch (err) {
    if (opts.signal?.aborted) return async () => {};
    warnError('Failed to acquire session liveness lockfile', err);
    return async () => {};
  }
}
