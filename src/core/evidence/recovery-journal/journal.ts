import {
  constants,
  closeSync,
  existsSync,
  ftruncateSync,
  fsyncSync,
  openSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { relative, sep } from 'node:path';
import type { SessionRef } from '../../types/session-ref.js';
import { rejectSymlinkTarget } from '../../../lib/fs.js';
import { lockSibling, withFileLock } from '../../../lib/file-lock.js';
import {
  assertExistingPathConfined,
  assertWritablePathConfined,
} from '../../../lib/path-confinement.js';
import { canonicalJSON } from '../../../utils/canonical-json.js';
import { sha256Hex } from '../../../utils/sha256.js';
import { error } from '../../../utils/error.js';
import { evidenceError } from '../errors.js';
import { assertRecoveryIdentifier, isRecoveryPayloadPath, recoveryJournalPath } from './paths.js';
import {
  MAX_RECOVERY_RECORD_BYTES,
  MAX_RECOVERY_REFS,
  recoveryCheckpointSchema,
  recoveryKind,
  recoveryRecordSchema,
} from './schema.js';
import type {
  RecoveryCheckpoint,
  RecoveryEvidenceKind,
  RecoveryEvidenceRecord,
  RecoveryEvidenceRef,
} from './schema.js';
import { ensureRecoveryParent, writeAllSync, writeRecoveryArtifact } from './artifacts.js';

export type RecoveryJournal = Readonly<{
  records: readonly RecoveryEvidenceRecord[];
  headHash: string | null;
}>;

export type RecoveryEvidenceWriteInput = Readonly<{
  sessionId?: string | undefined;
  epochId: string;
  kind: RecoveryEvidenceKind;
  operationId?: string | undefined;
  eventId?: string | undefined;
  payload: unknown;
  refs?: readonly string[] | undefined;
  after?: RecoveryCheckpoint | null | undefined;
}>;

export type RecoveryRecordInput = Readonly<{
  sessionId?: string | undefined;
  epochId: string;
  kind: RecoveryEvidenceKind;
  operationId?: string | undefined;
  eventId?: string | undefined;
  payloadRef: RecoveryEvidenceRef | string;
  refs?: readonly string[] | undefined;
  after?: RecoveryCheckpoint | null | undefined;
}>;

function recordPreimage(record: Omit<RecoveryEvidenceRecord, 'recordHash'>): string {
  return canonicalJSON(record);
}

function recordHash(record: Omit<RecoveryEvidenceRecord, 'recordHash'>): string {
  return sha256Hex(recordPreimage(record));
}

function validateRecoveryRecord(value: unknown): RecoveryEvidenceRecord {
  const parsed = recoveryRecordSchema.safeParse(value);
  if (!parsed.success)
    throw error('recovery-evidence-storage', 'recovery journal contains an invalid record');
  if (!isRecoveryPayloadPath(parsed.data.payloadRef)) {
    throw error(
      'recovery-evidence-storage',
      'recovery journal payload reference is outside the recovery namespace',
    );
  }
  const { recordHash: supplied, ...withoutHash } = parsed.data;
  if (recordHash(withoutHash) !== supplied) {
    throw error('recovery-evidence-storage', 'recovery journal record hash mismatch');
  }
  return parsed.data;
}

function readRecoveryJournalUnlocked(ref: SessionRef): RecoveryJournal {
  const filePath = recoveryJournalPath(ref);
  if (!existsSync(filePath)) return { records: [], headHash: null };
  const projectRelative = relative(ref.projectDir, filePath).split(sep).join('/');
  assertExistingPathConfined(projectRelative, ref.projectDir);
  rejectSymlinkTarget(filePath);
  const lines = readFileSync(filePath, 'utf8').split('\n');
  const records: RecoveryEvidenceRecord[] = [];
  let previousHash: string | null = null;
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    if (Buffer.byteLength(line, 'utf8') > MAX_RECOVERY_RECORD_BYTES) {
      throw error('recovery-evidence-storage', 'recovery journal record exceeds the bounded size');
    }
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw error('recovery-evidence-storage', 'recovery journal contains invalid JSON');
    }
    const record = validateRecoveryRecord(value);
    const expectedSequence = records.length + 1;
    if (record.sequence !== expectedSequence || record.prevHash !== previousHash) {
      throw error('recovery-evidence-storage', 'recovery journal hash chain is not contiguous');
    }
    records.push(record);
    previousHash = record.recordHash;
  }
  return { records, headHash: previousHash };
}

function assertRecoveryJournalPath(ref: SessionRef): void {
  const projectRelative = relative(ref.projectDir, recoveryJournalPath(ref)).split(sep).join('/');
  assertWritablePathConfined(projectRelative, ref.projectDir);
}

export function withRecoveryStorageLock<T>(ref: SessionRef, fn: () => T): T {
  assertRecoveryJournalPath(ref);
  const journal = recoveryJournalPath(ref);
  return withFileLock(
    lockSibling(journal),
    () => evidenceError.lockTimeout(lockSibling(journal)),
    fn,
  );
}

export function readRecoveryJournal(ref: SessionRef): RecoveryJournal {
  return withRecoveryStorageLock(ref, () => readRecoveryJournalUnlocked(ref));
}

/** Run a recovery projection repair while holding the journal lock. */
export function withRecoveryJournalLock<T>(
  ref: SessionRef,
  fn: (journal: RecoveryJournal) => T,
): T {
  return withRecoveryStorageLock(ref, () => fn(readRecoveryJournalUnlocked(ref)));
}

function appendJournalLine(ref: SessionRef, line: string): void {
  const filePath = recoveryJournalPath(ref);
  const bytes = Buffer.from(`${line}\n`, 'utf8');
  if (bytes.byteLength > MAX_RECOVERY_RECORD_BYTES) {
    throw error('recovery-evidence-storage', 'recovery journal record exceeds the bounded size');
  }
  ensureRecoveryParent(ref, filePath);
  rejectSymlinkTarget(filePath);
  const fd = openSync(
    filePath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeAllSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function truncateRecoveryJournal(ref: SessionRef, size: number): void {
  const filePath = recoveryJournalPath(ref);
  rejectSymlinkTarget(filePath);
  const fd = openSync(filePath, constants.O_WRONLY | constants.O_NOFOLLOW);
  try {
    ftruncateSync(fd, size);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function normaliseRefs(refs: readonly string[] | undefined): string[] {
  const values = [...(refs ?? [])];
  if (
    values.length > MAX_RECOVERY_REFS ||
    values.some((value) => value.length === 0 || value.length > 2048)
  ) {
    throw error(
      'recovery-evidence-storage',
      'recovery evidence references exceed the bounded size',
    );
  }
  return values;
}

function payloadPath(reference: RecoveryEvidenceRef | string): string {
  return typeof reference === 'string' ? reference : reference.path;
}

type NormalisedRecoveryRecordInput = Readonly<{
  sessionId: string;
  epochId: string;
  kind: RecoveryEvidenceKind;
  operationId: string | undefined;
  eventId: string;
  payloadRef: string;
  refs: readonly string[];
  after: RecoveryCheckpoint | null;
}>;

function normaliseRecoveryRecordInput(
  input: RecoveryRecordInput & { ref: SessionRef },
): NormalisedRecoveryRecordInput {
  const { ref } = input;
  assertRecoveryIdentifier(input.epochId, 'epoch id');
  const sessionId = input.sessionId ?? ref.sessionId;
  if (sessionId !== ref.sessionId)
    throw error('recovery-evidence-storage', 'recovery evidence session mismatch');
  const operationId = input.operationId;
  if (operationId !== undefined) assertRecoveryIdentifier(operationId, 'operation id');
  const payloadRef = payloadPath(input.payloadRef);
  if (!isRecoveryPayloadPath(payloadRef)) {
    throw error(
      'recovery-evidence-storage',
      'recovery payload reference is outside the recovery namespace',
    );
  }
  const refs = normaliseRefs(input.refs);
  const after = input.after ?? null;
  if (after !== null) {
    const parsed = recoveryCheckpointSchema.safeParse(after);
    if (!parsed.success)
      throw error('recovery-evidence-storage', 'recovery checkpoint failed its bounded schema');
  }
  const eventId =
    input.eventId ??
    `recovery-${sha256Hex(
      canonicalJSON({
        epochId: input.epochId,
        kind: input.kind,
        operationId: operationId ?? null,
        payloadRef,
        refs,
      }),
    ).slice(0, 48)}`;
  assertRecoveryIdentifier(eventId, 'event id');
  return {
    sessionId,
    epochId: input.epochId,
    kind: input.kind,
    operationId,
    eventId,
    payloadRef,
    refs,
    after,
  };
}

function recoveryRecordForJournal(
  journal: RecoveryJournal,
  input: NormalisedRecoveryRecordInput,
): Readonly<{ record: RecoveryEvidenceRecord; fresh: boolean }> {
  const existing = journal.records.find((record) => record.eventId === input.eventId);
  if (existing !== undefined) {
    const same =
      existing.epochId === input.epochId &&
      existing.kind === input.kind &&
      existing.operationId === input.operationId &&
      existing.payloadRef === input.payloadRef &&
      canonicalJSON(existing.refs) === canonicalJSON(input.refs) &&
      canonicalJSON(existing.after) === canonicalJSON(input.after);
    if (!same)
      throw error(
        'recovery-evidence-storage',
        'recovery event ID is already bound to different evidence',
      );
    return { record: existing, fresh: false };
  }
  const withoutHash: Omit<RecoveryEvidenceRecord, 'recordHash'> = {
    version: 1,
    sessionId: input.sessionId,
    epochId: input.epochId,
    sequence: journal.records.length + 1,
    prevHash: journal.headHash,
    eventId: input.eventId,
    kind: input.kind,
    ...(input.operationId === undefined ? {} : { operationId: input.operationId }),
    payloadRef: input.payloadRef,
    refs: [...input.refs],
    after: input.after,
  };
  const record: RecoveryEvidenceRecord = {
    ...withoutHash,
    recordHash: recordHash(withoutHash),
  };
  const parsed = recoveryRecordSchema.safeParse(record);
  if (!parsed.success)
    throw error('recovery-evidence-storage', 'recovery evidence record failed its bounded schema');
  return { record: parsed.data, fresh: true };
}

export function appendRecoveryRecord(
  input: RecoveryRecordInput & { ref: SessionRef },
): RecoveryEvidenceRecord {
  const normalised = normaliseRecoveryRecordInput(input);
  return withRecoveryStorageLock(input.ref, () => {
    const prepared = recoveryRecordForJournal(readRecoveryJournalUnlocked(input.ref), normalised);
    if (prepared.fresh) appendJournalLine(input.ref, canonicalJSON(prepared.record));
    return prepared.record;
  });
}

function writeRecoveryPayload(
  ref: SessionRef,
  input: RecoveryEvidenceWriteInput,
): Readonly<{ eventId: string; ref: RecoveryEvidenceRef }> {
  if (input.sessionId !== undefined && input.sessionId !== ref.sessionId) {
    throw error('recovery-evidence-storage', 'recovery evidence session mismatch');
  }
  assertRecoveryIdentifier(input.epochId, 'epoch id');
  if (input.operationId !== undefined) assertRecoveryIdentifier(input.operationId, 'operation id');
  if (input.eventId !== undefined) assertRecoveryIdentifier(input.eventId, 'event id');
  if (!recoveryKind.safeParse(input.kind).success)
    throw error('recovery-evidence-storage', 'invalid recovery evidence kind');
  const eventId =
    input.eventId ??
    `recovery-${sha256Hex(
      canonicalJSON({
        epochId: input.epochId,
        kind: input.kind,
        operationId: input.operationId ?? null,
        payload: input.payload,
      }),
    ).slice(0, 48)}`;
  const payload = writeRecoveryArtifact(ref, {
    epochId: input.epochId,
    eventId,
    payload: input.payload,
  });
  return { eventId, ref: payload };
}

export function writeRecoveryEvidence(
  ref: SessionRef,
  input: RecoveryEvidenceWriteInput,
): Readonly<{ ref: RecoveryEvidenceRef; record: RecoveryEvidenceRecord }> {
  const payload = writeRecoveryPayload(ref, input);
  const record = appendRecoveryRecord({
    ref,
    sessionId: input.sessionId,
    epochId: input.epochId,
    kind: input.kind,
    ...(input.operationId === undefined ? {} : { operationId: input.operationId }),
    eventId: payload.eventId,
    payloadRef: payload.ref,
    refs: input.refs,
    after: input.after,
  });
  return { ref: payload.ref, record };
}

export function transactRecoveryEvidence<T>(
  ref: SessionRef,
  input: RecoveryEvidenceWriteInput,
  transact: (
    evidence: Readonly<{ ref: RecoveryEvidenceRef; record: RecoveryEvidenceRecord }>,
  ) => Readonly<{ commit: boolean; result: T }>,
): Readonly<{ ref: RecoveryEvidenceRef; record: RecoveryEvidenceRecord; result: T }> {
  const payload = writeRecoveryPayload(ref, input);
  const normalised = normaliseRecoveryRecordInput({
    ref,
    sessionId: input.sessionId,
    epochId: input.epochId,
    kind: input.kind,
    operationId: input.operationId,
    eventId: payload.eventId,
    payloadRef: payload.ref,
    refs: input.refs,
    after: input.after,
  });
  return withRecoveryStorageLock(ref, () => {
    const journal = readRecoveryJournalUnlocked(ref);
    const prepared = recoveryRecordForJournal(journal, normalised);
    const journalSize = existsSync(recoveryJournalPath(ref))
      ? statSync(recoveryJournalPath(ref)).size
      : 0;
    if (prepared.fresh) appendJournalLine(ref, canonicalJSON(prepared.record));
    // A throwing transact deliberately keeps the fresh append: evidence commits before
    // state, and a crash between them must leave the durable record for idempotent retry.
    const decision = transact({ ref: payload.ref, record: prepared.record });
    if (!decision.commit && prepared.fresh) truncateRecoveryJournal(ref, journalSize);
    return { ref: payload.ref, record: prepared.record, result: decision.result };
  });
}
