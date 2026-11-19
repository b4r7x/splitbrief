import type { SessionRef } from '../../../core/types/session-ref.js';
import { LOCKFILE, sessionDir } from '../../../core/paths.js';
import { ensureSessionDir } from '../../../core/sessions/spec-files.js';
import { warnStderr } from '../../../lib/warn.js';
import { sessionError, sessionFileFailure } from '../../../core/sessions/errors.js';
import { SOFT_SEP } from '../../../core/separators.js';
import { error } from '../../../utils/error.js';
import { startHeartbeat } from './heartbeat.js';
import { sessionRelativePath } from '../../../core/sessions/ownership-marker.js';
import { checkSessionLockStatus } from '../../../core/sessions/lock/status.js';
import { sessionClaimPath, tryClaimSession } from '../../../core/sessions/lock/ownership.js';
import { markExited, writeLockfile } from '../../../core/sessions/lock/file.js';
import { reapSessionOrphans } from './orphan-reaper.js';

const workflowLivenessError = {
  sessionAlreadyLive: (sessionId: string, pid?: number) =>
    error('workflow-session-already-live', sessionError.stillActive(sessionId).message, {
      sessionId,
      pid,
    }),
  lockFailed: (what: string, path: string, cause: unknown) =>
    error('workflow-session-lock-failed', sessionFileFailure(what, path, cause), { path }, cause),
};

type LivenessOpts = SessionRef & {
  feature: string;
};

const heldRuns = new Map<string, Promise<void>>();

/** Settles once this process releases the run's liveness; `undefined` while it holds none. */
export function heldLiveness(ref: SessionRef): Promise<void> | undefined {
  return heldRuns.get(sessionDir(ref.projectDir, ref.sessionId));
}

function claimRun(ref: SessionRef): () => void {
  let release: (() => void) | null;
  try {
    release = tryClaimSession(ref);
  } catch (cause) {
    throw workflowLivenessError.lockFailed(
      'Could not hold the run lock',
      sessionClaimPath(ref.sessionId),
      cause,
    );
  }
  if (release === null) throw workflowLivenessError.sessionAlreadyLive(ref.sessionId);
  const { projectDir, sessionId } = ref;
  const dir = sessionDir(projectDir, sessionId);
  const lockfile = sessionRelativePath(sessionId, LOCKFILE);
  try {
    const status = checkSessionLockStatus({ sessionDir: dir, expectedSessionId: sessionId });
    if (status.kind === 'live' || status.kind === 'stale') {
      throw workflowLivenessError.sessionAlreadyLive(sessionId, status.data.pid);
    }
    if (status.kind === 'invalid') {
      throw workflowLivenessError.lockFailed(
        'Could not read the run lock',
        lockfile,
        'Invalid lock record',
      );
    }
  } catch (cause) {
    release();
    throw cause;
  }
  return release;
}

export async function withAtRestSession<T>(ref: SessionRef, mutate: () => Promise<T>): Promise<T> {
  await reapSessionOrphans(ref.projectDir, ref.sessionId);
  const release = claimRun(ref);
  try {
    return await mutate();
  } finally {
    release();
  }
}

export async function acquireLiveness(opts: LivenessOpts): Promise<() => Promise<void>> {
  const { projectDir, sessionId, feature } = opts;
  const dir = sessionDir(projectDir, sessionId);
  const lockfile = sessionRelativePath(sessionId, LOCKFILE);
  const releaseClaim = claimRun(opts);
  try {
    ensureSessionDir(projectDir, sessionId);
    const now = Date.now();
    try {
      await writeLockfile(dir, {
        pid: process.pid,
        startTimeMs: now,
        lastAliveMs: now,
        sessionId,
        feature,
      });
    } catch (cause) {
      throw workflowLivenessError.lockFailed('Could not write the run lock', lockfile, cause);
    }
  } catch (cause) {
    releaseClaim();
    throw cause;
  }

  const stopHeartbeat = startHeartbeat(dir);
  const held = Promise.withResolvers<void>();
  heldRuns.set(dir, held.promise);
  let release: Promise<void> | undefined;
  return () => {
    release ??= (async () => {
      stopHeartbeat();
      try {
        await markExited(dir, 0);
      } catch (err) {
        warnStderr(
          `${sessionFileFailure('Could not release the run lock', lockfile, err)}${SOFT_SEP}other SPLITBRIEF processes may have to wait for this process to exit`,
        );
      } finally {
        releaseClaim();
        heldRuns.delete(dir);
        held.resolve();
      }
    })();
    return release;
  };
}
