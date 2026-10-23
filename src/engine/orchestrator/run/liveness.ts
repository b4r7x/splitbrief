import { SPLITBRIEF_IDENTITY } from '../../../core/identity.js';
import type { SessionRef } from '../../../core/types/session-ref.js';
import { LOCKFILE, sessionDir } from '../../../core/paths.js';
import { ensureSessionDir } from '../../../core/paths-io.js';
import { warnStderr } from '../../../lib/warn.js';
import { sessionFileFailure } from '../../../core/sessions/errors.js';
import { SOFT_SEP } from '../../../core/separators.js';
import { error } from '../../../utils/error.js';
import { startHeartbeat } from './heartbeat.js';
import { sessionRelativePath } from '../../../core/sessions/ownership-marker.js';
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

type LivenessOpts = {
  projectDir: string;
  sessionId: string;
  feature: string;
  signal?: AbortSignal | undefined;
};

const heldRuns = new Map<string, Promise<void>>();

/** Settles once this process releases the run's liveness; `undefined` while it holds none. */
export function heldLiveness(ref: SessionRef): Promise<void> | undefined {
  return heldRuns.get(sessionDir(ref.projectDir, ref.sessionId));
}

// Every run writes a liveness lockfile + heartbeat so checkSessionLiveness can see an
// in-flight run and refuse a concurrent resume/continue.
export async function acquireLiveness(opts: LivenessOpts): Promise<() => Promise<void>> {
  const release = await lockLiveness(opts);
  const dir = sessionDir(opts.projectDir, opts.sessionId);
  const held = Promise.withResolvers<void>();
  heldRuns.set(dir, held.promise);
  return async () => {
    await release();
    if (heldRuns.get(dir) === held.promise) heldRuns.delete(dir);
    held.resolve();
  };
}

async function lockLiveness(opts: LivenessOpts): Promise<() => Promise<void>> {
  const dir = sessionDir(opts.projectDir, opts.sessionId);
  const lockfile = sessionRelativePath(opts.sessionId, LOCKFILE);
  ensureSessionDir(opts.projectDir, opts.sessionId);
  let status: SessionLivenessStatus;
  try {
    status = checkSessionLiveness(dir);
  } catch (err) {
    if (opts.signal?.aborted) return async () => {};
    warnStderr(
      `${sessionFileFailure('Could not read the run lock', lockfile, err)}${SOFT_SEP}another SPLITBRIEF process can open this run at the same time`,
    );
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
      feature: opts.feature,
    });
    const stopHeartbeat = startHeartbeat(dir);
    return async () => {
      stopHeartbeat();
      try {
        await markExited(dir, 0);
      } catch (err) {
        warnStderr(sessionFileFailure('Could not mark the run as ended', lockfile, err));
      }
    };
  } catch (err) {
    if (opts.signal?.aborted) return async () => {};
    warnStderr(
      `${sessionFileFailure('Could not write the run lock', lockfile, err)}${SOFT_SEP}another SPLITBRIEF process can open this run at the same time`,
    );
    return async () => {};
  }
}
