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
import { activeFile, validateSessionId, SPLITBRIEF_DIR } from '../paths.js';
import { narrowRecord } from '../../utils/type-guards.js';
import { error } from '../../utils/error.js';
import { SECURE_FILE_MODE, ensureSecureDir, rejectSymlinkTarget } from '../../lib/fs.js';
import { lockSibling, withFileLock } from '../../lib/file-lock.js';
import {
  assertExistingPathConfined,
  assertWritablePathConfined,
} from '../../lib/path-confinement.js';
import { isNodeError } from '../../lib/process/errors.js';
import type { SessionRef } from '../types/session-ref.js';

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
