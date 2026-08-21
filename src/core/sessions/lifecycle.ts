import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
  activeFile,
  sessionDir,
  sessionsRoot,
  STATE_FILE,
  validateSessionId,
  SPLITBRIEF_DIR,
  SESSIONS_DIR,
} from '../paths.js';
import { ensureSessionDir } from '../paths-io.js';
import { isTerminalPhase } from '../phases.js';
import { PhaseSchema, type Phase } from '../schemas/enums.js';
import { narrowRecord } from '../../utils/type-guards.js';
import { error } from '../../utils/error.js';
import { SECURE_FILE_MODE, ensureSecureDir, rejectSymlinkTarget } from '../../lib/fs.js';
import { lockSibling, withFileLock } from '../../lib/file-lock.js';
import {
  assertExistingPathConfined,
  assertWritablePathConfined,
} from '../../lib/path-confinement.js';
import { isNodeError } from '../../lib/process/errors.js';
import { slugify } from '../../utils/slugify.js';
import type { SessionRef } from '../types/session-ref.js';
import { assertStateAuthority, readStateAuthority } from '../state/authority.js';
import type { StateAuthorityReceipt } from '../state/types.js';
import { TRANSCRIPT_OMITTED_MESSAGE } from '../transcript-policy.js';
import { sessionError } from './errors.js';
import { findUnusedId } from './find-unused-id.js';
import {
  checkProcessIdentity,
  checkSessionLockStatus,
  type ProcessIdentityStatus,
  type SessionLockStatus,
  type SessionLockStatusOptions,
} from './lockfile-status.js';

const MAX_ACTIVE_BYTES = 512n;

type ActiveFileSnapshot = Readonly<{
  dev: bigint;
  ino: bigint;
  bytes: string;
}>;

export type ActiveMutationBoundary =
  | 'write-permissions'
  | 'write-commit'
  | 'clear-claim'
  | 'clear-captured';

export type ActiveMutationOptions = Readonly<{
  _beforeMutation?: ((boundary: ActiveMutationBoundary) => void) | undefined;
}>;

export type SessionOwnershipReceipt = Readonly<{
  version: 1;
  sessionId: string;
  generation: string;
}>;

export type ActiveSessionReceipt = Readonly<{
  version: 1;
  sessionId: string;
  generation: string;
}>;

export type NewSessionOwnership = Readonly<{
  ref: SessionRef;
  ownership: SessionOwnershipReceipt;
}>;

export type PreparedNewSession = NewSessionOwnership &
  Readonly<{
    active: ActiveSessionReceipt;
  }>;

export type ActiveSessionRecord =
  | Readonly<{ kind: 'legacy'; sessionId: string }>
  | Readonly<{ kind: 'v1'; receipt: ActiveSessionReceipt }>;

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

const CANONICAL_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const activeMutationError = {
  timeout: (projectDir: string) =>
    error('active-mutation-timeout', 'Timed out waiting to update the active session', {
      projectDir,
    }),
  conflict: (projectDir: string) =>
    error('active-mutation-conflict', 'The active session changed during an update', {
      projectDir,
    }),
  invalid: (filePath: string) =>
    error('active-mutation-invalid', 'The active session file is invalid', { filePath }),
} as const;

function assertGenerationReceipt(
  value: unknown,
): asserts value is SessionOwnershipReceipt | ActiveSessionReceipt {
  const record = narrowRecord(value);
  if (
    record === null ||
    Object.keys(record).sort().join(',') !== 'generation,sessionId,version' ||
    record.version !== 1 ||
    typeof record.sessionId !== 'string' ||
    typeof record.generation !== 'string' ||
    !CANONICAL_UUID_PATTERN.test(record.generation)
  ) {
    throw activeMutationError.invalid('session ownership receipt');
  }
  try {
    validateSessionId(record.sessionId);
  } catch {
    throw activeMutationError.invalid('session ownership receipt');
  }
}

export function assertSessionOwnershipReceipt(
  value: unknown,
): asserts value is SessionOwnershipReceipt {
  assertGenerationReceipt(value);
}

function assertActiveReceipt(ref: SessionRef, receipt: ActiveSessionReceipt): void {
  assertGenerationReceipt(receipt);
  validateSessionId(ref.sessionId);
  if (ref.sessionId !== receipt.sessionId) {
    throw activeMutationError.invalid('active session receipt');
  }
}

function parseActiveBytes(filePath: string, bytes: string): ActiveSessionRecord | null {
  const text = bytes.trim();
  if (text.length === 0) return null;
  if (!text.startsWith('{')) {
    try {
      validateSessionId(text);
    } catch {
      throw activeMutationError.invalid(filePath);
    }
    return { kind: 'legacy', sessionId: text };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
    assertGenerationReceipt(value);
  } catch {
    throw activeMutationError.invalid(filePath);
  }
  return { kind: 'v1', receipt: value };
}

function activeSnapshot(filePath: string): ActiveFileSnapshot | null {
  let descriptor: number;
  try {
    descriptor = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (cause) {
    if (isNodeError(cause) && cause.code === 'ENOENT') return null;
    throw cause;
  }
  try {
    const stat = fstatSync(descriptor, { bigint: true });
    if (!stat.isFile() || stat.size > MAX_ACTIVE_BYTES) {
      throw activeMutationError.invalid(filePath);
    }
    return { dev: stat.dev, ino: stat.ino, bytes: readFileSync(descriptor, 'utf8') };
  } finally {
    closeSync(descriptor);
  }
}

function removeFileBestEffort(filePath: string): void {
  try {
    rmSync(filePath, { force: true });
  } catch {
    // The committed active record remains authoritative; a sibling is recoverable.
  }
}

export function withSessionMutationLock<T>(projectDir: string, mutate: () => T): T {
  return withFileLock(
    lockSibling(activeFile(projectDir)),
    () => activeMutationError.timeout(projectDir),
    mutate,
  );
}

export function readActiveRecord(projectDir: string): ActiveSessionRecord | null {
  const p = activeFile(projectDir);
  if (!existsSync(p)) return null;
  try {
    rejectSymlinkTarget(p);
  } catch {
    return null;
  }
  assertExistingPathConfined(`${SPLITBRIEF_DIR}/active`, projectDir);
  const snapshot = activeSnapshot(p);
  return snapshot === null ? null : parseActiveBytes(p, snapshot.bytes);
}

export function readActive(projectDir: string): string | null {
  const record = readActiveRecord(projectDir);
  if (record === null) return null;
  return record.kind === 'legacy' ? record.sessionId : record.receipt.sessionId;
}

function writeActiveBytesLocked(
  projectDir: string,
  expected: ActiveFileSnapshot | null,
  bytes: string,
  options: ActiveMutationOptions,
): void {
  const target = activeFile(projectDir);
  const relativePath = `${SPLITBRIEF_DIR}/active`;
  assertWritablePathConfined(relativePath, projectDir);
  ensureSecureDir(dirname(target));
  assertWritablePathConfined(relativePath, projectDir);
  const temporary = join(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`);
  let descriptor: number;
  try {
    descriptor = openSync(temporary, 'wx', SECURE_FILE_MODE);
    try {
      writeFileSync(descriptor, bytes, 'utf8');
      options._beforeMutation?.('write-permissions');
      fchmodSync(descriptor, SECURE_FILE_MODE);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    options._beforeMutation?.('write-commit');
    if (expected === null) {
      try {
        linkSync(temporary, target);
      } catch {
        throw activeMutationError.conflict(projectDir);
      }
      removeFileBestEffort(temporary);
      return;
    }
    const claim = join(dirname(target), `.${basename(target)}.${randomUUID()}.claim`);
    assertWritablePathConfined(`${SPLITBRIEF_DIR}/${basename(claim)}`, projectDir);
    renameSync(target, claim);
    const captured = activeSnapshot(claim);
    if (
      captured === null ||
      captured.dev !== expected.dev ||
      captured.ino !== expected.ino ||
      captured.bytes !== expected.bytes
    ) {
      restoreClaimOrConflict(projectDir, claim, target);
    }
    try {
      linkSync(temporary, target);
    } catch {
      restoreClaimOrConflict(projectDir, claim, target);
    }
    removeFileBestEffort(temporary);
    removeFileBestEffort(claim);
  } catch (cause) {
    rmSync(temporary, { force: true });
    throw cause;
  }
}

export function writeActive(ref: SessionRef, options: ActiveMutationOptions = {}): void {
  const { projectDir, sessionId } = ref;
  validateSessionId(sessionId);
  withSessionMutationLock(projectDir, () => {
    const target = activeFile(projectDir);
    const snapshot = activeSnapshot(target);
    const current = snapshot === null ? null : parseActiveBytes(target, snapshot.bytes);
    if (current?.kind === 'v1') {
      throw activeMutationError.conflict(projectDir);
    }
    writeActiveBytesLocked(projectDir, snapshot, `${sessionId}\n`, options);
  });
}

function sameReceipt(left: ActiveSessionReceipt, right: ActiveSessionReceipt): boolean {
  return left.sessionId === right.sessionId && left.generation === right.generation;
}

function restoreClaimOrConflict(projectDir: string, claim: string, target: string): never {
  try {
    linkSync(claim, target);
    unlinkSync(claim);
  } catch {
    throw activeMutationError.conflict(projectDir);
  }
  throw activeMutationError.conflict(projectDir);
}

function claimAndClearActiveLocked(
  projectDir: string,
  snapshot: ActiveFileSnapshot,
  options: ActiveMutationOptions,
): void {
  const target = activeFile(projectDir);
  const claim = join(dirname(target), `.${basename(target)}.${randomUUID()}.claim`);
  assertWritablePathConfined(`${SPLITBRIEF_DIR}/${basename(claim)}`, projectDir);
  options._beforeMutation?.('clear-claim');
  renameSync(target, claim);
  options._beforeMutation?.('clear-captured');
  const captured = activeSnapshot(claim);
  if (
    captured === null ||
    captured.dev !== snapshot.dev ||
    captured.ino !== snapshot.ino ||
    captured.bytes !== snapshot.bytes
  ) {
    restoreClaimOrConflict(projectDir, claim, target);
  }
  unlinkSync(claim);
}

export function writeActiveReceiptLocked(
  ref: SessionRef,
  receipt: ActiveSessionReceipt,
  options: ActiveMutationOptions = {},
): void {
  assertActiveReceipt(ref, receipt);
  const target = activeFile(ref.projectDir);
  const snapshot = activeSnapshot(target);
  const current = snapshot === null ? null : parseActiveBytes(target, snapshot.bytes);
  if (current?.kind === 'v1' && sameReceipt(current.receipt, receipt)) {
    return;
  }
  if (current !== null) throw activeMutationError.conflict(ref.projectDir);
  writeActiveBytesLocked(ref.projectDir, snapshot, `${JSON.stringify(receipt)}\n`, options);
}

export function clearActiveReceiptLocked(
  ref: SessionRef,
  receipt: ActiveSessionReceipt,
  options: ActiveMutationOptions = {},
): boolean {
  assertActiveReceipt(ref, receipt);
  const target = activeFile(ref.projectDir);
  const snapshot = activeSnapshot(target);
  if (snapshot === null) return false;
  const current = parseActiveBytes(target, snapshot.bytes);
  if (current?.kind !== 'v1' || !sameReceipt(current.receipt, receipt)) return false;
  claimAndClearActiveLocked(ref.projectDir, snapshot, options);
  return true;
}

export function clearActiveReceipt(
  ref: SessionRef,
  receipt: ActiveSessionReceipt,
  options: ActiveMutationOptions = {},
): boolean {
  return withSessionMutationLock(ref.projectDir, () =>
    clearActiveReceiptLocked(ref, receipt, options),
  );
}

export function reactivateExistingSession(ref: SessionRef): ActiveSessionReceipt {
  validateSessionId(ref.sessionId);
  return withSessionMutationLock(ref.projectDir, () => {
    const target = activeFile(ref.projectDir);
    const snapshot = activeSnapshot(target);
    const current = snapshot === null ? null : parseActiveBytes(target, snapshot.bytes);
    const currentSessionId =
      current?.kind === 'legacy' ? current.sessionId : current?.receipt.sessionId;
    if (currentSessionId !== undefined && currentSessionId !== ref.sessionId) {
      throw activeMutationError.conflict(ref.projectDir);
    }
    const receipt: ActiveSessionReceipt = {
      version: 1,
      sessionId: ref.sessionId,
      generation: randomUUID(),
    };
    writeActiveBytesLocked(ref.projectDir, snapshot, `${JSON.stringify(receipt)}\n`, {});
    return receipt;
  });
}

export function clearActive(ref: SessionRef, options: ActiveMutationOptions = {}): boolean {
  const { projectDir, sessionId } = ref;
  validateSessionId(sessionId);
  return withSessionMutationLock(projectDir, () => {
    const target = activeFile(projectDir);
    const snapshot = activeSnapshot(target);
    if (snapshot === null) return false;
    const current = parseActiveBytes(target, snapshot.bytes);
    if (current?.kind !== 'legacy' || current.sessionId !== sessionId) return false;
    claimAndClearActiveLocked(projectDir, snapshot, options);
    return true;
  });
}

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
    default: {
      const _exhaustive: never = processIdentity;
      return _exhaustive;
    }
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
    default: {
      const _exhaustive: never = lock;
      return _exhaustive;
    }
  }
}

function resultForHeartbeat(
  lock: SessionLockStatus,
  activePointer: SessionPointerStatus,
): SessionLivenessResult {
  switch (lock.kind) {
    case 'live':
      return {
        live: true,
        takeoverMayBeAttempted: false,
        authority: 'missing',
        processIdentity: processIdentityForLock(lock),
        heartbeat: lock.kind,
        activePointer,
        reason: 'heartbeat-live',
      };
    case 'stale':
      return {
        live: false,
        takeoverMayBeAttempted: false,
        authority: 'missing',
        processIdentity: processIdentityForLock(lock),
        heartbeat: lock.kind,
        activePointer,
        reason: 'heartbeat-stale',
      };
    case 'dead':
      return {
        live: false,
        takeoverMayBeAttempted: true,
        authority: 'missing',
        processIdentity: processIdentityForLock(lock),
        heartbeat: lock.kind,
        activePointer,
        reason: 'heartbeat-dead',
      };
    case 'exited':
      return {
        live: false,
        takeoverMayBeAttempted: true,
        authority: 'missing',
        processIdentity: processIdentityForLock(lock),
        heartbeat: lock.kind,
        activePointer,
        reason: 'heartbeat-exited',
      };
    case 'missing':
      return {
        live: false,
        takeoverMayBeAttempted: true,
        authority: 'missing',
        processIdentity: 'not-checked',
        heartbeat: lock.kind,
        activePointer,
        reason: 'heartbeat-missing',
      };
    case 'invalid':
      return {
        live: false,
        takeoverMayBeAttempted: true,
        authority: 'missing',
        processIdentity: 'not-checked',
        heartbeat: lock.kind,
        activePointer,
        reason: 'heartbeat-invalid',
      };
    default: {
      const _exhaustive: never = lock;
      return _exhaustive;
    }
  }
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
  switch (observed.authority) {
    case 'live':
      return {
        live: true,
        takeoverMayBeAttempted: false,
        authority: observed.authority,
        processIdentity: observed.processIdentity,
        heartbeat: lock.kind,
        activePointer,
        reason: 'authority-live',
      };
    case 'dead':
      return {
        live: false,
        takeoverMayBeAttempted: true,
        authority: observed.authority,
        processIdentity: observed.processIdentity,
        heartbeat: lock.kind,
        activePointer,
        reason: 'authority-dead',
      };
    case 'pid-reused':
      return {
        live: false,
        takeoverMayBeAttempted: true,
        authority: observed.authority,
        processIdentity: observed.processIdentity,
        heartbeat: lock.kind,
        activePointer,
        reason: 'authority-pid-reused',
      };
    case 'unknown':
      return {
        live: true,
        takeoverMayBeAttempted: false,
        authority: observed.authority,
        processIdentity: observed.processIdentity,
        heartbeat: lock.kind,
        activePointer,
        reason: 'authority-unknown',
      };
    case 'invalid':
      return {
        live: true,
        takeoverMayBeAttempted: false,
        authority: observed.authority,
        processIdentity: observed.processIdentity,
        heartbeat: lock.kind,
        activePointer,
        reason: 'authority-invalid',
      };
    case 'missing':
      return resultForHeartbeat(lock, activePointer);
    default: {
      const _exhaustive: never = observed.authority;
      return _exhaustive;
    }
  }
}

export function isSessionLive(ref: SessionRef): boolean {
  return inspectSessionLiveness(ref).live;
}

export const MAX_SLUG_LENGTH = 50;
const MAX_COLLISION_ATTEMPTS = 999;
const OPAQUE_ID_LENGTH = 12;
const OPAQUE_SESSION_PATTERN = /^\d{4}-\d{2}-\d{2}-session-[a-f0-9]{12}(?:-\d+)?$/;
export const TRANSCRIPT_OMITTED_FEATURE = TRANSCRIPT_OMITTED_MESSAGE;

export interface SessionIdOptions {
  persistTranscript?: boolean | undefined;
}

function findUniqueId(projectDir: string, base: string): string {
  const root = sessionsRoot(projectDir);
  const id = findUnusedId({
    root,
    base,
    suffixer: (candidateBase, collisionIndex) => `${candidateBase}-${collisionIndex + 1}`,
    maxCollisionAttempts: MAX_COLLISION_ATTEMPTS - 1,
  });
  if (id !== null) return id;
  throw sessionError.idCollision(base, MAX_COLLISION_ATTEMPTS);
}

export function generateSessionId(
  projectDir: string,
  feature: string,
  now: Date = new Date(),
  opts: SessionIdOptions = {},
): string {
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const day = String(now.getUTCDate()).padStart(2, '0');
  const date = `${year}-${month}-${day}`;
  if (opts.persistTranscript === false) {
    return findUniqueId(projectDir, `${date}-${generateOpaqueSessionSlug()}`);
  }
  const slug = slugify(feature, MAX_SLUG_LENGTH) || 'unknown';
  const base = `${date}-${slug}`;
  return findUniqueId(projectDir, base);
}

export function generateOpaqueSessionSlug(): string {
  return `session-${randomUUID().replaceAll('-', '').slice(0, OPAQUE_ID_LENGTH)}`;
}

export function isOpaqueSessionId(sessionId: string): boolean {
  return OPAQUE_SESSION_PATTERN.test(sessionId);
}

export function featureForTranscriptPolicy(feature: string, persistTranscript: boolean): string {
  return persistTranscript ? feature : TRANSCRIPT_OMITTED_FEATURE;
}

export function beginSession(
  projectDir: string,
  feature: string,
  opts: SessionIdOptions = {},
): string {
  const sessionId = generateSessionId(projectDir, feature, new Date(), opts);
  ensureSessionDir(projectDir, sessionId);
  writeActive({ projectDir, sessionId });
  return sessionId;
}
