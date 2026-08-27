import type { WorkflowMode } from '../../../core/schemas/enums.js';
import { SPLITBRIEF_IDENTITY } from '../../../core/identity.js';
import { sessionDir } from '../../../core/paths.js';
import { ensureSessionDir } from '../../../core/paths-io.js';
import { featureForTranscriptPolicy } from '../../../core/sessions/session-id.js';
import { warnError } from '../../../lib/warn.js';
import { error } from '../../../utils/error.js';
import { startHeartbeat } from '../../ipc/heartbeat.js';
import { checkServerStatus, markExited, writeLockfile } from '../../ipc/lockfile.js';

const workflowLivenessError = {
  sessionAlreadyLive: (sessionId: string, pid: number) =>
    error(
      'workflow-session-already-live',
      `session '${sessionId}' is already running (pid ${pid}). Use '${SPLITBRIEF_IDENTITY.executable} continue ${sessionId}' to attach or resume it.`,
      { sessionId, pid },
    ),
};

function isDetachedLivenessOwner(data: { pid: number; authToken?: string | undefined }): boolean {
  return data.pid === process.pid && data.authToken !== undefined;
}

// Every run (TUI, headless, RPC) writes a liveness lockfile + heartbeat so checkServerStatus
// can see an in-flight interactive run and refuse a concurrent resume/continue. The detached
// server already owns an authenticated lockfile for the session; do not clobber it.
export async function acquireLiveness(opts: {
  projectDir: string;
  sessionId: string;
  feature: string;
  mode: WorkflowMode;
  persistTranscript: boolean;
  signal?: AbortSignal | undefined;
}): Promise<() => Promise<void>> {
  const dir = sessionDir(opts.projectDir, opts.sessionId);
  ensureSessionDir(opts.projectDir, opts.sessionId);
  let status: Awaited<ReturnType<typeof checkServerStatus>>;
  try {
    status = await checkServerStatus(dir);
  } catch (err) {
    if (opts.signal?.aborted) return async () => {};
    warnError('Failed to inspect session liveness lockfile', err);
    return async () => {};
  }
  if (status.alive) {
    if (isDetachedLivenessOwner(status.data)) return async () => {};
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
      feature: featureForTranscriptPolicy(opts.feature, opts.persistTranscript),
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
