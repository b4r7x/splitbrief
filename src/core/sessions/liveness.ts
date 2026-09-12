import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sessionDir, STATE_FILE, SPLITBRIEF_DIR, SESSIONS_DIR } from '../paths.js';
import { isTerminalPhase } from '../phases.js';
import { PhaseSchema, type Phase } from '../schemas/enums.js';
import { assertNever, narrowRecord } from '../../utils/type-guards.js';
import { rejectSymlinkTarget } from '../../lib/fs.js';
import { assertExistingPathConfined } from '../../lib/path-confinement.js';
import type { SessionRef } from '../types/session-ref.js';
import { type ActiveSessionRecord, readActiveRecord } from './active-pointer.js';
import {
  checkProcessIdentity,
  checkSessionLockStatus,
  type ProcessIdentityStatus,
  type SessionLockStatus,
  type SessionLockStatusOptions,
} from './lockfile-status.js';

export type SessionLivenessReason =
  | 'state-missing'
  | 'terminal-state'
  | 'heartbeat-live'
  | 'heartbeat-stale'
  | 'heartbeat-dead'
  | 'heartbeat-exited'
  | 'heartbeat-missing'
  | 'heartbeat-invalid';

export type SessionPointerStatus = 'matching' | 'mismatched' | 'missing' | 'invalid';

export type SessionLivenessResult = Readonly<{
  live: boolean;
  takeoverMayBeAttempted: boolean;
  processIdentity: ProcessIdentityStatus | 'not-checked';
  heartbeat: SessionLockStatus['kind'];
  activePointer: SessionPointerStatus;
  reason: SessionLivenessReason;
}>;

export type SessionLivenessDeps = Readonly<{
  readPhase?: ((ref: SessionRef) => Phase | null) | undefined;
  readActive?: ((projectDir: string) => ActiveSessionRecord | null) | undefined;
  checkLock?: ((options: SessionLockStatusOptions) => SessionLockStatus) | undefined;
}>;

function readSessionPhase(ref: SessionRef): Phase | null {
  const { projectDir, sessionId } = ref;
  const stateFile = join(sessionDir(projectDir, sessionId), STATE_FILE);
  if (!existsSync(stateFile)) return null;
  try {
    rejectSymlinkTarget(stateFile);
    assertExistingPathConfined(
      `${SPLITBRIEF_DIR}/${SESSIONS_DIR}/${sessionId}/${STATE_FILE}`,
      projectDir,
    );
    const raw = narrowRecord(JSON.parse(readFileSync(stateFile, 'utf-8')));
    if (!raw || typeof raw.phase !== 'string') return null;
    const parsed = PhaseSchema.safeParse(raw.phase);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function activePointerStatus(
  ref: SessionRef,
  readActive: (projectDir: string) => ActiveSessionRecord | null,
): SessionPointerStatus {
  try {
    const record = readActive(ref.projectDir);
    if (record === null) return 'missing';
    const sessionId = record.kind === 'legacy' ? record.sessionId : record.receipt.sessionId;
    return sessionId === ref.sessionId ? 'matching' : 'mismatched';
  } catch {
    return 'invalid';
  }
}

function readSessionLockStatus(
  ref: SessionRef,
  checkLock: (options: SessionLockStatusOptions) => SessionLockStatus,
): SessionLockStatus {
  try {
    return checkLock({
      sessionDir: sessionDir(ref.projectDir, ref.sessionId),
      expectedSessionId: ref.sessionId,
    });
  } catch {
    return { kind: 'invalid' };
  }
}

function processIdentityForLock(lock: SessionLockStatus): ProcessIdentityStatus | 'not-checked' {
  switch (lock.kind) {
    case 'exited':
    case 'dead':
    case 'stale':
    case 'live':
      return checkProcessIdentity(lock.data.pid, lock.data.startTimeMs);
    case 'missing':
    case 'invalid':
      return 'not-checked';
    default:
      return assertNever(lock);
  }
}

type LivenessOutcome = Readonly<{
  live: boolean;
  takeoverMayBeAttempted: boolean;
  reason: SessionLivenessReason;
}>;

const HEARTBEAT_OUTCOMES: Readonly<Record<SessionLockStatus['kind'], LivenessOutcome>> = {
  live: { live: true, takeoverMayBeAttempted: false, reason: 'heartbeat-live' },
  stale: { live: false, takeoverMayBeAttempted: false, reason: 'heartbeat-stale' },
  dead: { live: false, takeoverMayBeAttempted: true, reason: 'heartbeat-dead' },
  exited: { live: false, takeoverMayBeAttempted: true, reason: 'heartbeat-exited' },
  missing: { live: false, takeoverMayBeAttempted: true, reason: 'heartbeat-missing' },
  invalid: { live: false, takeoverMayBeAttempted: true, reason: 'heartbeat-invalid' },
};

function resultForHeartbeat(
  lock: SessionLockStatus,
  activePointer: SessionPointerStatus,
): SessionLivenessResult {
  return {
    ...HEARTBEAT_OUTCOMES[lock.kind],
    processIdentity: processIdentityForLock(lock),
    heartbeat: lock.kind,
    activePointer,
  };
}

export function inspectSessionLiveness(
  ref: SessionRef,
  deps: SessionLivenessDeps = {},
): SessionLivenessResult {
  const readPhase = deps.readPhase ?? readSessionPhase;
  const readActive = deps.readActive ?? readActiveRecord;
  const activePointer = activePointerStatus(ref, readActive);
  const phase = readPhase(ref);
  if (phase === null) {
    return {
      live: false,
      takeoverMayBeAttempted: false,
      processIdentity: 'not-checked',
      heartbeat: 'missing',
      activePointer,
      reason: 'state-missing',
    };
  }
  if (isTerminalPhase(phase)) {
    return {
      live: false,
      takeoverMayBeAttempted: false,
      processIdentity: 'not-checked',
      heartbeat: 'missing',
      activePointer,
      reason: 'terminal-state',
    };
  }

  const lock = readSessionLockStatus(ref, deps.checkLock ?? checkSessionLockStatus);
  return resultForHeartbeat(lock, activePointer);
}

export function isSessionLive(ref: SessionRef): boolean {
  return inspectSessionLiveness(ref).live;
}
