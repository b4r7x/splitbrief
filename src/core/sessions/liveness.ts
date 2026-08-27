import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sessionDir, STATE_FILE, SPLITBRIEF_DIR, SESSIONS_DIR } from '../paths.js';
import { isTerminalPhase } from '../phases.js';
import { PhaseSchema, type Phase } from '../schemas/enums.js';
import { assertNever, narrowRecord } from '../../utils/type-guards.js';
import { rejectSymlinkTarget } from '../../lib/fs.js';
import { assertExistingPathConfined } from '../../lib/path-confinement.js';
import type { SessionRef } from '../types/session-ref.js';
import { assertStateAuthority, readStateAuthority } from '../state/authority.js';
import type { StateAuthorityReceipt } from '../state/types.js';
import { type ActiveSessionRecord, readActiveRecord } from './active-pointer.js';
import {
  checkProcessIdentity,
  checkSessionLockStatus,
  type ProcessIdentityStatus,
  type SessionLockStatus,
  type SessionLockStatusOptions,
} from './lockfile-status.js';

export type SessionLivenessAuthority =
  | 'missing'
  | 'invalid'
  | 'live'
  | 'dead'
  | 'pid-reused'
  | 'unknown';

export type SessionLivenessReason =
  | 'state-missing'
  | 'terminal-state'
  | 'authority-live'
  | 'authority-dead'
  | 'authority-pid-reused'
  | 'authority-unknown'
  | 'authority-invalid'
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
  authority: SessionLivenessAuthority;
  processIdentity: ProcessIdentityStatus | 'not-checked';
  heartbeat: SessionLockStatus['kind'];
  activePointer: SessionPointerStatus;
  reason: SessionLivenessReason;
}>;

export type SessionLivenessDeps = Readonly<{
  readPhase?: ((ref: SessionRef) => Phase | null) | undefined;
  readActive?: ((projectDir: string) => ActiveSessionRecord | null) | undefined;
  checkLock?: ((options: SessionLockStatusOptions) => SessionLockStatus) | undefined;
  readAuthority?: ((ref: SessionRef) => StateAuthorityReceipt | null) | undefined;
  assertAuthority?:
    | ((input: { ref: SessionRef; receipt: StateAuthorityReceipt }) => void)
    | undefined;
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

type AuthorityObservation = Readonly<{
  authority: SessionLivenessAuthority;
  processIdentity: ProcessIdentityStatus | 'not-checked';
}>;

function observeAuthority(
  ref: SessionRef,
  readAuthority: (ref: SessionRef) => StateAuthorityReceipt | null,
  assertAuthority: (input: { ref: SessionRef; receipt: StateAuthorityReceipt }) => void,
): AuthorityObservation {
  let receipt: StateAuthorityReceipt | null;
  try {
    receipt = readAuthority(ref);
  } catch {
    return { authority: 'invalid', processIdentity: 'not-checked' };
  }
  if (receipt === null) return { authority: 'missing', processIdentity: 'not-checked' };

  const processIdentity = checkProcessIdentity(receipt.pid, Number(receipt.processStart));
  switch (processIdentity) {
    case 'live':
      try {
        assertAuthority({ ref, receipt });
        return { authority: 'live', processIdentity };
      } catch {
        return { authority: 'invalid', processIdentity };
      }
    case 'dead':
      return { authority: 'dead', processIdentity };
    case 'pid-reused':
      return { authority: 'pid-reused', processIdentity };
    case 'unknown':
      return { authority: 'unknown', processIdentity };
    default:
      return assertNever(processIdentity);
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

const AUTHORITY_OUTCOMES: Readonly<Record<SessionLivenessAuthority, LivenessOutcome | null>> = {
  live: { live: true, takeoverMayBeAttempted: false, reason: 'authority-live' },
  dead: { live: false, takeoverMayBeAttempted: true, reason: 'authority-dead' },
  'pid-reused': { live: false, takeoverMayBeAttempted: true, reason: 'authority-pid-reused' },
  unknown: { live: true, takeoverMayBeAttempted: false, reason: 'authority-unknown' },
  invalid: { live: true, takeoverMayBeAttempted: false, reason: 'authority-invalid' },
  missing: null,
};

function resultForHeartbeat(
  lock: SessionLockStatus,
  activePointer: SessionPointerStatus,
): SessionLivenessResult {
  return {
    ...HEARTBEAT_OUTCOMES[lock.kind],
    authority: 'missing',
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
      authority: 'missing',
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
      authority: 'missing',
      processIdentity: 'not-checked',
      heartbeat: 'missing',
      activePointer,
      reason: 'terminal-state',
    };
  }

  const lock = readSessionLockStatus(ref, deps.checkLock ?? checkSessionLockStatus);
  const observed = observeAuthority(
    ref,
    deps.readAuthority ?? readStateAuthority,
    deps.assertAuthority ?? assertStateAuthority,
  );
  const outcome = AUTHORITY_OUTCOMES[observed.authority];
  if (outcome === null) return resultForHeartbeat(lock, activePointer);
  return {
    ...outcome,
    authority: observed.authority,
    processIdentity: observed.processIdentity,
    heartbeat: lock.kind,
    activePointer,
  };
}

export function isSessionLive(ref: SessionRef): boolean {
  return inspectSessionLiveness(ref).live;
}
