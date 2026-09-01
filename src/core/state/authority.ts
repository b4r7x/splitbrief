import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  chmodSync,
  constants,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import {
  SPLITBRIEF_DIR,
  SESSIONS_DIR,
  STATE_FILE,
  stateAuthorityDirectory,
  sessionDir,
} from '../paths.js';
import type { SessionRef } from '../types/session-ref.js';
import type {
  StateAuthorityAcquisitionResult,
  StateAuthorityCandidate,
  StateAuthorityReceipt,
} from './types.js';
import {
  commitStateAuthorityFence,
  type StateAuthorityFenceCommitResult,
} from './resume-authority.js';
import { SECURE_DIR_MODE, SECURE_FILE_MODE } from '../../lib/fs.js';
import { isNodeError } from '../../lib/process/errors.js';
import { currentProcessStartTimeMs, readProcessStartTimeMs } from '../../lib/process/start-time.js';
import {
  assertExistingPathConfined,
  assertWritablePathConfined,
} from '../../lib/path-confinement.js';
import { assertSessionDirConfined } from '../sessions/confinement.js';
import { error } from '../../utils/error.js';
import { isRecord } from '../../utils/type-guards.js';

const AUTHORITY_RECORD = 'owner.json';
const AUTHORITY_VERSION = 1;
const PROCESS_START_TOLERANCE_MS = 2000;
const RECORD_MAX_BYTES = 4096;

type AuthorityRecord = Readonly<{
  version: 1;
  kind: 'candidate' | 'usable';
  sessionId: string;
  ownerId: string;
  pid: number;
  processStart: string;
  runId: string;
  acquisitionId: string;
  fence: number;
  stateRevision: number;
  stateDigest: string | null;
}>;

type AuthorityHead = Readonly<{
  kind: 'missing' | 'present' | 'malformed';
  stateRevision: number;
  fence: number;
  digest: string | null;
  expectedRevision: {
    rawSha256: string;
    fileIdentity: {
      dev: bigint;
      ino: bigint;
      size: bigint;
      mtimeNs: bigint;
    };
  } | null;
}>;

type AcquireInput = Readonly<{
  ref: SessionRef;
  purpose: 'resume' | 'new-workflow';
  ownerId?: string | undefined;
  runId?: string | undefined;
  acquisitionId?: string | undefined;
  pid?: number | undefined;
  processStart?: string | undefined;
}>;

type AssertInput = Readonly<{
  ref: SessionRef;
  receipt: StateAuthorityReceipt;
}>;

const authorityError = {
  invalid: (message: string, data?: unknown) => error('state-authority-invalid', message, data),
} as const;

function authorityRelativeDirectory(ref: SessionRef, suffix = ''): string {
  return join(SPLITBRIEF_DIR, SESSIONS_DIR, ref.sessionId, 'state-authority.lock', suffix);
}

function recordPath(ref: SessionRef): string {
  return join(stateAuthorityDirectory(ref), AUTHORITY_RECORD);
}

function assertAuthorityRoot(ref: SessionRef): void {
  assertSessionDirConfined(ref.projectDir, ref.sessionId);
  const directory = sessionDir(ref.projectDir, ref.sessionId);
  if (!pathExists(directory)) {
    throw authorityError.invalid('The session directory does not exist.');
  }
  const sessionStat = lstatSync(directory, { bigint: true });
  if (!sessionStat.isDirectory() || sessionStat.isSymbolicLink()) {
    throw authorityError.invalid('The session path is not a real directory.');
  }
  assertExistingPathConfined(join(SPLITBRIEF_DIR, SESSIONS_DIR, ref.sessionId), ref.projectDir);
  assertWritablePathConfined(authorityRelativeDirectory(ref), ref.projectDir);
}

function assertAuthorityDirectory(ref: SessionRef, directory: string): void {
  assertWritablePathConfined(
    authorityRelativeDirectory(ref, relative(stateAuthorityDirectory(ref), directory)),
    ref.projectDir,
  );
  const stat = lstatSync(directory, { bigint: true });
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw authorityError.invalid('The state authority path is not a real directory.');
  }
  if ((stat.mode & 0o077n) !== 0n) {
    throw authorityError.invalid('The state authority directory must be owner-only.');
  }
}

function assertRecordFile(ref: SessionRef, path: string): void {
  assertWritablePathConfined(
    authorityRelativeDirectory(ref, relative(stateAuthorityDirectory(ref), path)),
    ref.projectDir,
  );
  const stat = lstatSync(path, { bigint: true });
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw authorityError.invalid('The state authority record is not a regular file.');
  }
  if ((stat.mode & 0o077n) !== 0n) {
    throw authorityError.invalid('The state authority record must be owner-only.');
  }
  if (stat.size > BigInt(RECORD_MAX_BYTES)) {
    throw authorityError.invalid('The state authority record is too large.');
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512;
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
}

function isProcessStart(value: unknown): value is string {
  return isNonEmptyString(value) && Number.isFinite(Number(value));
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function parseRecord(ref: SessionRef, value: unknown): AuthorityRecord {
  if (!isRecord(value))
    throw authorityError.invalid('The state authority record is not an object.');
  const keys = Object.keys(value).sort().join(',');
  if (
    keys !==
    'acquisitionId,fence,kind,ownerId,pid,processStart,runId,sessionId,stateDigest,stateRevision,version'
  ) {
    throw authorityError.invalid('The state authority record has unexpected fields.');
  }
  if (
    value.version !== AUTHORITY_VERSION ||
    (value.kind !== 'candidate' && value.kind !== 'usable') ||
    value.sessionId !== ref.sessionId ||
    !isNonEmptyString(value.ownerId) ||
    !isNonEmptyString(value.runId) ||
    !isNonEmptyString(value.acquisitionId) ||
    !isProcessStart(value.processStart) ||
    typeof value.pid !== 'number' ||
    !Number.isInteger(value.pid) ||
    value.pid <= 0 ||
    !isNonNegativeInteger(value.fence) ||
    !isNonNegativeInteger(value.stateRevision) ||
    (value.stateDigest !== null && !isDigest(value.stateDigest)) ||
    (value.kind === 'candidate' && value.stateDigest !== null) ||
    (value.kind === 'usable' && !isDigest(value.stateDigest))
  ) {
    throw authorityError.invalid('The state authority record is malformed or foreign.');
  }
  return {
    version: 1,
    kind: value.kind,
    sessionId: value.sessionId,
    ownerId: value.ownerId,
    pid: value.pid,
    processStart: value.processStart,
    runId: value.runId,
    acquisitionId: value.acquisitionId,
    fence: value.fence,
    stateRevision: value.stateRevision,
    stateDigest: value.stateDigest,
  };
}

function recordBytes(record: AuthorityRecord): string {
  return `${JSON.stringify(record)}\n`;
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (cause) {
    if (isNodeError(cause) && cause.code === 'ENOENT') return false;
    throw cause;
  }
}

function readRecordAt(ref: SessionRef, directory: string): AuthorityRecord {
  assertAuthorityDirectory(ref, directory);
  const path = join(directory, AUTHORITY_RECORD);
  if (!pathExists(path)) throw authorityError.invalid('The state authority record is missing.');
  assertRecordFile(ref, path);
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (cause) {
    throw authorityError.invalid('The state authority record cannot be read.', { cause });
  }
  try {
    return parseRecord(ref, JSON.parse(raw));
  } catch (cause) {
    if (isAuthorityError(cause)) throw cause;
    throw authorityError.invalid('The state authority record contains invalid JSON.', { cause });
  }
}

function readRecord(ref: SessionRef): AuthorityRecord | null {
  const directory = stateAuthorityDirectory(ref);
  if (!pathExists(directory)) return null;
  return readRecordAt(ref, directory);
}

function isAuthorityError(value: unknown): value is Error & { kind: 'state-authority-invalid' } {
  return value instanceof Error && 'kind' in value && value.kind === 'state-authority-invalid';
}

function writeAll(descriptor: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const written = writeSync(descriptor, bytes, offset, bytes.byteLength - offset, offset);
    if (written <= 0)
      throw authorityError.invalid('The state authority record write did not advance.');
    offset += written;
  }
}

function syncDirectory(directory: string): void {
  try {
    const descriptor = openSync(directory, constants.O_RDONLY);
    try {
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
  } catch (cause) {
    if (
      !isNodeError(cause) ||
      (cause.code !== 'EINVAL' && cause.code !== 'ENOTSUP' && cause.code !== 'EOPNOTSUPP')
    ) {
      throw cause;
    }
  }
}

function writeRecordExclusive(ref: SessionRef, record: AuthorityRecord): void {
  const directory = stateAuthorityDirectory(ref);
  const path = recordPath(ref);
  assertAuthorityDirectory(ref, directory);
  assertWritablePathConfined(authorityRelativeDirectory(ref, AUTHORITY_RECORD), ref.projectDir);
  let descriptor: number;
  try {
    descriptor = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      SECURE_FILE_MODE,
    );
  } catch (cause) {
    throw authorityError.invalid('The state authority record could not be created.', { cause });
  }
  try {
    fchmodSync(descriptor, SECURE_FILE_MODE);
    writeAll(descriptor, Buffer.from(recordBytes(record), 'utf8'));
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  syncDirectory(directory);
}

function replaceRecord(ref: SessionRef, record: AuthorityRecord): void {
  const directory = stateAuthorityDirectory(ref);
  const path = recordPath(ref);
  assertAuthorityDirectory(ref, directory);
  assertRecordFile(ref, path);
  const temporary = join(directory, `.${AUTHORITY_RECORD}.${randomUUID()}.tmp`);
  assertWritablePathConfined(
    authorityRelativeDirectory(ref, relative(stateAuthorityDirectory(ref), temporary)),
    ref.projectDir,
  );
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      SECURE_FILE_MODE,
    );
    fchmodSync(descriptor, SECURE_FILE_MODE);
    writeAll(descriptor, Buffer.from(recordBytes(record), 'utf8'));
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    assertRecordFile(ref, path);
    renameSync(temporary, path);
    syncDirectory(directory);
  } catch (cause) {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      unlinkSync(temporary);
    } catch {
      // Preserve the old or newly committed owner record after a cut point.
    }
    throw cause;
  }
}

function authorityRecordFromCandidate(candidate: StateAuthorityCandidate): AuthorityRecord {
  return {
    version: 1,
    kind: 'candidate',
    sessionId: candidate.sessionId,
    ownerId: candidate.ownerId,
    pid: candidate.pid,
    processStart: candidate.processStart,
    runId: candidate.runId,
    acquisitionId: candidate.acquisitionId,
    fence: candidate.fence,
    stateRevision: candidate.stateRevision,
    stateDigest: null,
  };
}

function authorityRecordFromReceipt(receipt: StateAuthorityReceipt): AuthorityRecord {
  return {
    version: 1,
    kind: 'usable',
    sessionId: receipt.sessionId,
    ownerId: receipt.ownerId,
    pid: receipt.pid,
    processStart: receipt.processStart,
    runId: receipt.runId,
    acquisitionId: receipt.acquisitionId,
    fence: receipt.fence,
    stateRevision: receipt.stateRevision,
    stateDigest: receipt.stateDigest,
  };
}

function receiptFromRecord(record: AuthorityRecord): StateAuthorityReceipt {
  if (record.kind !== 'usable' || record.stateDigest === null) {
    throw authorityError.invalid('The state authority has not committed a state fence.');
  }
  return {
    kind: 'usable',
    sessionId: record.sessionId,
    ownerId: record.ownerId,
    pid: record.pid,
    processStart: record.processStart,
    runId: record.runId,
    acquisitionId: record.acquisitionId,
    fence: record.fence,
    stateRevision: record.stateRevision,
    stateDigest: record.stateDigest,
  };
}

function processIdentityState(record: AuthorityRecord): 'live' | 'dead' | 'unknown' {
  const expected = Number(record.processStart);
  const observed = readProcessStartTimeMs(record.pid);
  if (observed !== null && Number.isFinite(expected)) {
    return Math.abs(observed - expected) <= PROCESS_START_TOLERANCE_MS ? 'live' : 'dead';
  }
  try {
    process.kill(record.pid, 0);
    return 'unknown';
  } catch (cause) {
    return isNodeError(cause) && cause.code === 'ESRCH' ? 'dead' : 'unknown';
  }
}

function readAuthorityHead(ref: SessionRef): AuthorityHead {
  const path = join(sessionDir(ref.projectDir, ref.sessionId), STATE_FILE);
  assertWritablePathConfined(
    join(SPLITBRIEF_DIR, SESSIONS_DIR, ref.sessionId, STATE_FILE),
    ref.projectDir,
  );
  if (!pathExists(path)) {
    return { kind: 'missing', stateRevision: 0, fence: 0, digest: null, expectedRevision: null };
  }
  try {
    const stat = lstatSync(path, { bigint: true });
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw authorityError.invalid('The state path is not a real regular file.');
    }
    const bytes = readFileSync(path);
    const digest = createHash('sha256').update(bytes).digest('hex');
    const expectedRevision = {
      rawSha256: digest,
      fileIdentity: {
        dev: stat.dev,
        ino: stat.ino,
        size: stat.size,
        mtimeNs: stat.mtimeNs,
      },
    };
    const malformed = {
      kind: 'malformed',
      stateRevision: 0,
      fence: 0,
      digest,
      expectedRevision,
    } as const;
    let value: unknown;
    try {
      value = JSON.parse(bytes.toString('utf8'));
    } catch {
      return malformed;
    }
    if (!isRecord(value) || (value.stateVersion !== 3 && value.stateVersion !== 4)) {
      return malformed;
    }
    const stateRevision =
      value.stateVersion === 4 && isNonNegativeInteger(value.stateRevision)
        ? value.stateRevision
        : 0;
    const fenceRecord = isRecord(value.stateFence) ? value.stateFence : null;
    const fence =
      value.stateVersion === 4 && fenceRecord !== null && isNonNegativeInteger(fenceRecord.token)
        ? fenceRecord.token
        : 0;
    return {
      kind: 'present',
      stateRevision,
      fence,
      digest,
      expectedRevision,
    };
  } catch (cause) {
    if (isAuthorityError(cause)) throw cause;
    throw authorityError.invalid('The state head cannot be read safely.', { cause });
  }
}

function candidateFor(input: AcquireInput, head: AuthorityHead): StateAuthorityCandidate {
  return {
    kind: 'candidate',
    sessionId: input.ref.sessionId,
    ownerId: input.ownerId ?? randomUUID(),
    pid: input.pid ?? process.pid,
    processStart: input.processStart ?? String(Math.round(currentProcessStartTimeMs())),
    runId: input.runId ?? randomUUID(),
    acquisitionId: input.acquisitionId ?? randomUUID(),
    fence: head.fence,
    stateRevision: head.stateRevision,
    stateDigest: null,
  };
}

function assertCandidate(candidate: StateAuthorityCandidate, ref: SessionRef): void {
  if (
    candidate.kind !== 'candidate' ||
    candidate.sessionId !== ref.sessionId ||
    !isNonEmptyString(candidate.ownerId) ||
    !isNonEmptyString(candidate.runId) ||
    !isNonEmptyString(candidate.acquisitionId) ||
    !isProcessStart(candidate.processStart) ||
    !Number.isInteger(candidate.pid) ||
    candidate.pid <= 0 ||
    !isNonNegativeInteger(candidate.fence) ||
    !isNonNegativeInteger(candidate.stateRevision) ||
    candidate.stateDigest !== null
  ) {
    throw authorityError.invalid('The state authority candidate is malformed or foreign.');
  }
}

function assertReceiptIdentity(receipt: StateAuthorityReceipt, ref: SessionRef): void {
  if (
    receipt.kind !== 'usable' ||
    receipt.sessionId !== ref.sessionId ||
    !isNonEmptyString(receipt.ownerId) ||
    !isNonEmptyString(receipt.runId) ||
    !isNonEmptyString(receipt.acquisitionId) ||
    !isProcessStart(receipt.processStart) ||
    !Number.isInteger(receipt.pid) ||
    receipt.pid <= 0 ||
    !isNonNegativeInteger(receipt.fence) ||
    !isNonNegativeInteger(receipt.stateRevision) ||
    !isDigest(receipt.stateDigest)
  ) {
    throw authorityError.invalid('The state authority receipt is malformed or foreign.');
  }
}

function sameReceipt(left: AuthorityRecord, right: StateAuthorityReceipt): boolean {
  return (
    left.kind === 'usable' &&
    left.sessionId === right.sessionId &&
    left.ownerId === right.ownerId &&
    left.pid === right.pid &&
    left.processStart === right.processStart &&
    left.runId === right.runId &&
    left.acquisitionId === right.acquisitionId &&
    left.fence === right.fence &&
    left.stateRevision === right.stateRevision &&
    left.stateDigest === right.stateDigest
  );
}

function sameOwner(left: AuthorityRecord, right: StateAuthorityReceipt): boolean {
  return (
    left.kind === 'usable' &&
    left.sessionId === right.sessionId &&
    left.ownerId === right.ownerId &&
    left.pid === right.pid &&
    left.processStart === right.processStart &&
    left.runId === right.runId &&
    left.acquisitionId === right.acquisitionId &&
    left.fence === right.fence
  );
}

function removeClaimedAuthority(ref: SessionRef, claim: string): void {
  assertAuthorityDirectory(ref, claim);
  rmSync(claim, { recursive: true, force: false });
}

function restoreClaim(ref: SessionRef, claim: string, directory: string): boolean {
  if (pathExists(directory)) {
    removeClaimedAuthority(ref, claim);
    return false;
  }
  try {
    renameSync(claim, directory);
    return true;
  } catch (cause) {
    if (isNodeError(cause) && cause.code === 'EEXIST') {
      removeClaimedAuthority(ref, claim);
      return false;
    }
    throw cause;
  }
}

function removeCandidateAuthority(ref: SessionRef, candidate: StateAuthorityCandidate): boolean {
  const directory = stateAuthorityDirectory(ref);
  if (!pathExists(directory)) return false;
  const record = readRecord(ref);
  if (record === null || record.kind !== 'candidate') return false;
  const expected = authorityRecordFromCandidate(candidate);
  if (recordBytes(record) !== recordBytes(expected)) return false;
  const sessionPath = sessionDir(ref.projectDir, ref.sessionId);
  const claim = join(sessionPath, `.${ref.sessionId}.state-authority.${randomUUID()}.claim`);
  assertWritablePathConfined(
    join(SPLITBRIEF_DIR, SESSIONS_DIR, ref.sessionId, relative(sessionPath, claim)),
    ref.projectDir,
  );
  try {
    renameSync(directory, claim);
  } catch (cause) {
    if (isNodeError(cause) && cause.code === 'ENOENT') return false;
    throw cause;
  }
  try {
    const claimed = readRecordAt(ref, claim);
    if (claimed.kind !== 'candidate' || recordBytes(claimed) !== recordBytes(expected)) {
      restoreClaim(ref, claim, directory);
      return false;
    }
    if (pathExists(directory)) {
      removeClaimedAuthority(ref, claim);
      return false;
    }
    removeClaimedAuthority(ref, claim);
    return true;
  } catch (cause) {
    if (pathExists(claim)) {
      try {
        restoreClaim(ref, claim, directory);
      } catch {
        // Never remove a claim when restoration is uncertain.
      }
    }
    if (isAuthorityError(cause)) return false;
    throw cause;
  }
}

function takeOverDeadAuthority(ref: SessionRef): boolean {
  const directory = stateAuthorityDirectory(ref);
  const existing = readRecord(ref);
  if (existing === null) return true;
  if (processIdentityState(existing) !== 'dead') {
    throw authorityError.invalid(
      'The current state authority owner is live or cannot be proven dead.',
    );
  }
  const sessionPath = sessionDir(ref.projectDir, ref.sessionId);
  const claim = join(sessionPath, `.${ref.sessionId}.state-authority.${randomUUID()}.claim`);
  assertWritablePathConfined(
    join(SPLITBRIEF_DIR, SESSIONS_DIR, ref.sessionId, relative(sessionPath, claim)),
    ref.projectDir,
  );
  try {
    renameSync(directory, claim);
  } catch (cause) {
    if (isNodeError(cause) && (cause.code === 'ENOENT' || cause.code === 'EEXIST')) return false;
    throw cause;
  }
  try {
    if (pathExists(directory)) {
      removeClaimedAuthority(ref, claim);
      return false;
    }
    mkdirSync(directory, { mode: SECURE_DIR_MODE });
    chmodDirectory(directory);
    removeClaimedAuthority(ref, claim);
    return true;
  } catch (cause) {
    if (pathExists(claim)) {
      try {
        restoreClaim(ref, claim, directory);
      } catch {
        // Keep the claim when restoration is uncertain; never touch a successor.
      }
    }
    if (isNodeError(cause) && cause.code === 'EEXIST') return false;
    throw cause;
  }
}

function chmodDirectory(directory: string): void {
  const stat = lstatSync(directory, { bigint: true });
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw authorityError.invalid('The state authority directory is not a real directory.');
  }
  // chmod is intentionally separate from mkdir so an existing umask cannot weaken the contract.
  chmodSync(directory, SECURE_DIR_MODE);
}

function cleanupReadOnlyPermit(ref: SessionRef, candidate: StateAuthorityCandidate): void {
  try {
    removeCandidateAuthority(ref, candidate);
  } catch {
    // A successor or a failed parse must never be removed by read-only cleanup.
  }
}

function resultForCommit(
  ref: SessionRef,
  candidate: StateAuthorityCandidate,
  result: StateAuthorityFenceCommitResult,
): StateAuthorityAcquisitionResult {
  if (result.kind === 'fenced') {
    const receipt = result.receipt;
    assertReceiptIdentity(receipt, ref);
    replaceRecord(ref, authorityRecordFromReceipt(receipt));
    const stored = readRecord(ref);
    if (stored === null || !sameReceipt(stored, receipt)) {
      throw authorityError.invalid('The committed state authority receipt could not be verified.');
    }
    return {
      kind: 'fenced',
      receipt,
      promotedFromVersion: result.promotedFromVersion,
    };
  }
  if (result.kind === 'read-only') {
    cleanupReadOnlyPermit(ref, candidate);
    return { kind: 'read-only', permit: result.permit };
  }
  throw authorityError.invalid(
    result.kind === 'conflict'
      ? `State authority fence lost a compare-and-swap: ${result.message}`
      : `State authority fence durability is uncertain: ${result.message}`,
    result,
  );
}

export function acquireStateAuthority(input: AcquireInput): StateAuthorityAcquisitionResult {
  assertAuthorityRoot(input.ref);
  if (input.purpose !== 'resume' && input.purpose !== 'new-workflow') {
    throw authorityError.invalid('State authority acquisition has an invalid purpose.');
  }
  const directory = stateAuthorityDirectory(input.ref);
  let created = false;
  try {
    try {
      mkdirSync(directory, { mode: SECURE_DIR_MODE });
      chmodDirectory(directory);
      created = true;
    } catch (cause) {
      if (!isNodeError(cause) || cause.code !== 'EEXIST') throw cause;
      if (!lstatSync(directory).isDirectory()) {
        throw authorityError.invalid('The state authority path is not a directory.');
      }
      if (!takeOverDeadAuthority(input.ref)) {
        // takeOverDeadAuthority throws for a live/unknown owner and returns false only on a race.
        throw authorityError.invalid('The state authority directory is already claimed.');
      }
      created = true;
    }

    const head = readAuthorityHead(input.ref);
    const candidate = candidateFor(input, head);
    assertCandidate(candidate, input.ref);
    writeRecordExclusive(input.ref, authorityRecordFromCandidate(candidate));
    const nextFence = head.kind === 'present' && head.fence >= 0 ? head.fence + 1 : 1;
    const committed = commitStateAuthorityFence({
      ref: input.ref,
      candidate,
      rawStateDigest: head.digest,
      expectedRevision: head.expectedRevision,
      nextFence,
    });
    if (
      committed.kind === 'read-only' &&
      input.purpose === 'new-workflow' &&
      head.kind === 'missing'
    ) {
      return { kind: 'new-workflow', candidate };
    }
    return resultForCommit(input.ref, candidate, committed);
  } catch (cause) {
    if (created) {
      try {
        const current = readRecord(input.ref);
        if (current?.kind === 'candidate') {
          const directoryPath = stateAuthorityDirectory(input.ref);
          rmSync(directoryPath, { recursive: true, force: false });
        }
      } catch {
        // Preserve an uncertain authority record for a later proven-dead takeover.
      }
    }
    if (isAuthorityError(cause)) throw cause;
    throw authorityError.invalid('State authority acquisition failed.', { cause });
  }
}

function assertStateAuthorityInternal(
  input: AssertInput & Readonly<{ ownerLiveness: 'required' | 'not-checked' }>,
): void {
  assertAuthorityRoot(input.ref);
  assertReceiptIdentity(input.receipt, input.ref);
  const stored = readRecord(input.ref);
  if (stored === null || !sameReceipt(stored, input.receipt)) {
    throw authorityError.invalid('The state authority receipt does not own the current directory.');
  }
  if (input.ownerLiveness === 'required' && processIdentityState(stored) !== 'live') {
    throw authorityError.invalid(
      'The state authority owner is dead or its process identity changed.',
    );
  }
  const head = readAuthorityHead(input.ref);
  if (
    head.kind !== 'present' ||
    head.digest !== input.receipt.stateDigest ||
    head.stateRevision !== input.receipt.stateRevision ||
    head.fence !== input.receipt.fence
  ) {
    throw authorityError.invalid(
      'The state authority receipt does not match the committed state fence.',
    );
  }
}

export function assertStateAuthority(input: AssertInput): void {
  assertStateAuthorityInternal({ ...input, ownerLiveness: 'required' });
}

export function readStateAuthority(ref: SessionRef): StateAuthorityReceipt | null {
  assertAuthorityRoot(ref);
  const record = readRecord(ref);
  if (record === null) return null;
  const receipt = receiptFromRecord(record);
  assertStateAuthorityInternal({ ref, receipt, ownerLiveness: 'not-checked' });
  return receipt;
}

export function assertCandidateAuthority(
  ref: SessionRef,
  candidate: StateAuthorityCandidate,
): void {
  assertAuthorityRoot(ref);
  assertCandidate(candidate, ref);
  const stored = readRecord(ref);
  if (
    stored === null ||
    recordBytes(stored) !== recordBytes(authorityRecordFromCandidate(candidate))
  ) {
    throw authorityError.invalid('The state authority candidate no longer owns its directory.');
  }
}

export function promoteCandidateAuthority(
  ref: SessionRef,
  candidate: StateAuthorityCandidate,
  head: Readonly<{ fence: number; stateRevision: number; stateDigest: string }>,
): StateAuthorityReceipt {
  assertCandidateAuthority(ref, candidate);
  const receipt: StateAuthorityReceipt = {
    kind: 'usable',
    sessionId: candidate.sessionId,
    ownerId: candidate.ownerId,
    pid: candidate.pid,
    processStart: candidate.processStart,
    runId: candidate.runId,
    acquisitionId: candidate.acquisitionId,
    fence: head.fence,
    stateRevision: head.stateRevision,
    stateDigest: head.stateDigest,
  };
  assertReceiptIdentity(receipt, ref);
  replaceRecord(ref, authorityRecordFromReceipt(receipt));
  assertStateAuthorityInternal({ ref, receipt, ownerLiveness: 'required' });
  return receipt;
}

export function refreshStateAuthority(
  ref: SessionRef,
  previous: StateAuthorityReceipt,
  next: Readonly<{ stateRevision: number; stateDigest: string }>,
): StateAuthorityReceipt {
  assertAuthorityRoot(ref);
  assertReceiptIdentity(previous, ref);
  if (!isNonNegativeInteger(next.stateRevision) || !isDigest(next.stateDigest)) {
    throw authorityError.invalid('The refreshed state authority receipt is malformed.');
  }
  const stored = readRecord(ref);
  if (stored === null || !sameOwner(stored, previous)) {
    throw authorityError.invalid('The state authority changed before its head was refreshed.');
  }
  const head = readAuthorityHead(ref);
  if (
    head.kind !== 'present' ||
    head.stateRevision !== next.stateRevision ||
    head.digest !== next.stateDigest ||
    head.fence !== previous.fence
  ) {
    throw authorityError.invalid('The refreshed state authority does not match the state head.');
  }
  const refreshed = { ...previous, ...next };
  replaceRecord(ref, authorityRecordFromReceipt(refreshed));
  return refreshed;
}

export function releaseStateAuthority(ref: SessionRef, receipt: StateAuthorityReceipt): boolean {
  try {
    assertStateAuthorityInternal({ ref, receipt, ownerLiveness: 'not-checked' });
  } catch {
    return false;
  }
  const directory = stateAuthorityDirectory(ref);
  const sessionPath = sessionDir(ref.projectDir, ref.sessionId);
  const claim = join(sessionPath, `.${ref.sessionId}.state-authority.${randomUUID()}.release`);
  assertWritablePathConfined(
    join(SPLITBRIEF_DIR, SESSIONS_DIR, ref.sessionId, relative(sessionPath, claim)),
    ref.projectDir,
  );
  try {
    renameSync(directory, claim);
  } catch (cause) {
    if (isNodeError(cause) && cause.code === 'ENOENT') return false;
    throw cause;
  }
  try {
    const claimed = readRecordAt(ref, claim);
    if (!sameReceipt(claimed, receipt)) {
      restoreClaim(ref, claim, directory);
      return false;
    }
    if (pathExists(directory)) {
      removeClaimedAuthority(ref, claim);
      return false;
    }
    const head = readAuthorityHead(ref);
    if (
      head.kind !== 'present' ||
      head.digest !== receipt.stateDigest ||
      head.stateRevision !== receipt.stateRevision ||
      head.fence !== receipt.fence
    ) {
      restoreClaim(ref, claim, directory);
      return false;
    }
    const claimedRecordPath = join(claim, AUTHORITY_RECORD);
    unlinkSync(claimedRecordPath);
    syncDirectory(claim);
    removeClaimedAuthority(ref, claim);
    return true;
  } catch {
    if (pathExists(claim)) {
      try {
        restoreClaim(ref, claim, directory);
      } catch {
        // Preserve an uncertain claim rather than touching a successor.
      }
    }
    return false;
  }
}
