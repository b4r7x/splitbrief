import {
  constants,
  closeSync,
  existsSync,
  ftruncateSync,
  fsyncSync,
  openSync,
  readFileSync,
  statSync,
  writeSync,
} from 'node:fs';
import { join, relative, sep } from 'node:path';
import { z } from 'zod';
import {
  RecoveryBudgetResourceSchema,
  type RecoveryBudgetResource,
} from '../schemas/brief-recovery/budget.js';
import { sessionDir } from '../paths.js';
import { ensureSecureDir, rejectSymlinkTarget } from '../../lib/fs.js';
import { lockSibling, withFileLock } from '../../lib/file-lock.js';
import { evidenceError } from './errors.js';
import type { SessionRef } from '../types/session-ref.js';
import {
  assertExistingPathConfined,
  assertWritablePathConfined,
} from '../../lib/path-confinement.js';
import { canonicalJSON } from '../../utils/canonical-json.js';
import { sha256Hex } from '../../utils/sha256.js';
import { error } from '../../utils/error.js';

const RECOVERY_JOURNAL_FILE = 'brief-recovery.jsonl';
const RECOVERY_ROOT = 'brief-recovery';
const RECOVERY_EPOCHS_DIR = 'epochs';
const RECOVERY_PAYLOAD_DIR = 'payload';
const RECOVERY_SIDECAR_DIR = 'sidecars';
const RECOVERY_MANIFEST_FILE = 'manifest.json';
const MAX_RECOVERY_RECORD_BYTES = 64 * 1024;
const MAX_RECOVERY_PAYLOAD_BYTES = 256 * 1024;
const MAX_RECOVERY_RECORDS = 1_000_000;
const MAX_RECOVERY_REFS = 64;
const MAX_RECOVERY_OUTBOX = 256;

const recoveryIdentifier = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const recoveryHash = z.string().regex(/^[a-f0-9]{64}$/u);
const recoveryPath = z
  .string()
  .min(1)
  .max(2048)
  .regex(/^[^\\]+$/u)
  .refine((value) => !value.split('/').includes('..'), {
    message: 'recovery path must not contain parent traversal',
  });
const recoveryKind = z.enum([
  'initial-result',
  'auto-repair-exhausted',
  'receipt',
  'outcome',
  'provider-failure',
  'storage-failure',
  'input-disposition',
  'rejection',
  'reservation',
  'usage-reconciliation',
  'no-progress',
  'terminal-accounting',
  'epoch-closed',
  'late-result',
  'late-usage',
  'replay',
]);

function isRecoveryPayloadPath(value: string): boolean {
  return recoveryPath.safeParse(value).success && value.startsWith(`${RECOVERY_ROOT}/`);
}

export type RecoveryEvidenceKind = z.infer<typeof recoveryKind>;

const recoveryReferenceSchema = z.strictObject({
  revision: z.literal(1),
  hash: recoveryHash,
  path: z
    .string()
    .min(1)
    .max(1024)
    .regex(/^[^\\]+$/u)
    .refine((value) => !value.split('/').includes('..'), {
      message: 'recovery evidence path must not contain parent traversal',
    }),
});

export type RecoveryEvidenceRef = z.infer<typeof recoveryReferenceSchema>;

const recoveryCheckpointSchema = z.strictObject({
  stateRevision: z.number().int().nonnegative().max(MAX_RECOVERY_RECORDS),
  recoveryRevision: z.number().int().nonnegative().max(MAX_RECOVERY_RECORDS),
  status: z.string().min(1).max(128),
  activeOperationId: recoveryIdentifier.nullable(),
  evidenceHead: recoveryHash,
});

export type RecoveryCheckpoint = z.infer<typeof recoveryCheckpointSchema>;

const recoveryRecordSchema = z.strictObject({
  version: z.literal(1),
  sessionId: recoveryIdentifier,
  epochId: recoveryIdentifier,
  sequence: z.number().int().positive().max(MAX_RECOVERY_RECORDS),
  prevHash: recoveryHash.nullable(),
  recordHash: recoveryHash,
  eventId: recoveryIdentifier,
  kind: recoveryKind,
  operationId: recoveryIdentifier.optional(),
  payloadRef: recoveryPath,
  refs: z.array(z.string().min(1).max(2048)).max(MAX_RECOVERY_REFS),
  after: recoveryCheckpointSchema.nullable(),
});

export type RecoveryEvidenceRecord = z.infer<typeof recoveryRecordSchema>;

const recoveryManifestSchema = z.strictObject({
  version: z.literal(1),
  sessionId: recoveryIdentifier,
  epochId: recoveryIdentifier,
  disposition: z.enum(['continued', 'approved', 'rejected']),
  closedAt: z.string().min(1).max(128),
  headHash: recoveryHash,
  journalHead: recoveryHash,
  sidecarNamespace: z
    .string()
    .min(1)
    .max(2048)
    .regex(/^[^\\]+$/u),
  outbox: z
    .array(
      z.strictObject({
        eventId: recoveryIdentifier,
        payloadRef: recoveryPath,
        acknowledged: z.boolean(),
      }),
    )
    .max(MAX_RECOVERY_OUTBOX),
  manifestHash: recoveryHash,
});

export type RecoveryEpochManifest = z.infer<typeof recoveryManifestSchema>;

export type RecoveryOutboxEntry = Readonly<{
  eventId: string;
  payloadRef: string;
  acknowledged: boolean;
}>;

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

export type RecoverySidecarKind = 'late-result' | 'late-usage' | 'replay';

export type RecoverySidecarWriteInput = Readonly<{
  epochId: string;
  operationId: string;
  kind: RecoverySidecarKind;
  payload: unknown;
  intentHash?: string | undefined;
}>;

export type RecoverySidecarResult = Readonly<{
  ref: RecoveryEvidenceRef;
  record: RecoveryEvidenceRecord;
  manifest: RecoveryEpochManifest;
}>;

export type RecoveryReplayResult = Readonly<{
  manifest: RecoveryEpochManifest;
  receipt: RecoveryEvidenceRecord | null;
  sidecar: RecoverySidecarResult;
}>;

export type RecoveryEpochCloseInput = Readonly<{
  epochId: string;
  disposition: RecoveryEpochManifest['disposition'];
  closedAt: string;
  headHash: string;
  outbox?: readonly RecoveryOutboxEntry[] | undefined;
}>;

export type RecoveryBudgetResourceKind = 'reservation' | 'usage-reconciliation';

export type RecoveryBudgetResourceWriteInput = Readonly<{
  epochId: string;
  operationId: string;
  kind: RecoveryBudgetResourceKind;
  resource: RecoveryBudgetResource;
  after?: RecoveryCheckpoint | null | undefined;
}>;

export type RecoveryBudgetResourceRecord = Readonly<{
  kind: RecoveryBudgetResourceKind;
  resource: RecoveryBudgetResource;
  recordHash: string;
}>;

export function recoveryJournalPath(ref: SessionRef): string {
  return join(sessionDir(ref.projectDir, ref.sessionId), RECOVERY_JOURNAL_FILE);
}

export function recoveryEpochDir(ref: SessionRef, epochId: string): string {
  assertRecoveryIdentifier(epochId, 'epoch id');
  return join(
    sessionDir(ref.projectDir, ref.sessionId),
    RECOVERY_ROOT,
    RECOVERY_EPOCHS_DIR,
    epochId,
  );
}

export function recoveryManifestPath(ref: SessionRef, epochId: string): string {
  return join(recoveryEpochDir(ref, epochId), RECOVERY_MANIFEST_FILE);
}

export function recoverySidecarDir(ref: SessionRef, epochId: string): string {
  return join(recoveryEpochDir(ref, epochId), RECOVERY_SIDECAR_DIR);
}

export function recoveryArtifactPath(
  ref: SessionRef,
  epochId: string,
  eventId: string,
  payloadHash: string,
): string {
  assertRecoveryIdentifier(epochId, 'epoch id');
  assertRecoveryIdentifier(eventId, 'event id');
  assertRecoveryHash(payloadHash, 'payload hash');
  return join(
    recoveryEpochDir(ref, epochId),
    RECOVERY_PAYLOAD_DIR,
    `${eventId}-${payloadHash}.json`,
  );
}

export function recoverySidecarPath(
  ref: SessionRef,
  epochId: string,
  operationId: string,
  kind: RecoverySidecarKind,
  payloadHash: string,
): string {
  assertRecoveryIdentifier(operationId, 'operation id');
  assertRecoveryHash(payloadHash, 'payload hash');
  return join(recoverySidecarDir(ref, epochId), `${operationId}-${kind}-${payloadHash}.json`);
}

function recoveryProjectPath(ref: SessionRef, absolutePath: string): string {
  const session = sessionDir(ref.projectDir, ref.sessionId);
  const projectRelative = relative(ref.projectDir, absolutePath).split(sep).join('/');
  if (projectRelative.length === 0 || projectRelative.startsWith('../')) {
    throw error('recovery-evidence-storage', 'recovery evidence path escaped the project');
  }
  assertWritablePathConfined(projectRelative, ref.projectDir);
  return relative(session, absolutePath).split(sep).join('/');
}

function assertRecoveryIdentifier(value: string, label: string): void {
  if (!recoveryIdentifier.safeParse(value).success) {
    throw error('recovery-evidence-storage', `Invalid recovery ${label}`);
  }
}

function assertRecoveryHash(value: string, label: string): void {
  if (!recoveryHash.safeParse(value).success)
    throw error('recovery-evidence-storage', `Invalid recovery ${label}`);
}

function ensureRecoveryParent(ref: SessionRef, absolutePath: string): void {
  const projectRelative = relative(ref.projectDir, absolutePath).split(sep).join('/');
  assertWritablePathConfined(projectRelative, ref.projectDir);
  ensureSecureDir(join(ref.projectDir, projectRelative.split('/').slice(0, -1).join('/')));
  assertWritablePathConfined(projectRelative, ref.projectDir);
}

function writeAllSync(fd: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const written = writeSync(fd, bytes, offset, bytes.byteLength - offset);
    if (written <= 0)
      throw error('recovery-evidence-storage', 'recovery evidence write made no progress');
    offset += written;
  }
}

function writeCreateExclusive(ref: SessionRef, filePath: string, bytes: Buffer): void {
  if (bytes.byteLength > MAX_RECOVERY_PAYLOAD_BYTES) {
    throw error('recovery-evidence-storage', 'recovery evidence payload exceeds the bounded size');
  }
  ensureRecoveryParent(ref, filePath);
  rejectSymlinkTarget(filePath);
  try {
    const fd = openSync(
      filePath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      writeAllSync(fd, bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch (err: unknown) {
    const code = err && typeof err === 'object' && 'code' in err ? err.code : undefined;
    if (code !== 'EEXIST') throw err;
    rejectSymlinkTarget(filePath);
    const existing = readFileSync(filePath);
    if (!existing.equals(bytes))
      throw error('recovery-evidence-storage', 'recovery evidence artifact hash collision');
  }
}

function canonicalPayload(payload: unknown): { bytes: Buffer; hash: string } {
  const bytes = Buffer.from(`${canonicalJSON(payload)}\n`, 'utf8');
  return { bytes, hash: sha256Hex(bytes) };
}

function artifactRef(ref: SessionRef, filePath: string, payloadHash: string): RecoveryEvidenceRef {
  const path = recoveryProjectPath(ref, filePath);
  return { revision: 1, hash: payloadHash, path };
}

export function writeRecoveryArtifact(
  ref: SessionRef,
  input: Readonly<{ epochId: string; eventId: string; payload: unknown }>,
): RecoveryEvidenceRef {
  const { bytes, hash } = canonicalPayload(input.payload);
  const filePath = recoveryArtifactPath(ref, input.epochId, input.eventId, hash);
  writeCreateExclusive(ref, filePath, bytes);
  return artifactRef(ref, filePath, hash);
}

export function readRecoveryArtifact(ref: SessionRef, reference: RecoveryEvidenceRef): unknown {
  const validated = recoveryReferenceSchema.safeParse(reference);
  if (!validated.success)
    throw error('recovery-evidence-storage', 'recovery artifact reference is invalid');
  if (!reference.path.startsWith(`${RECOVERY_ROOT}/`)) {
    throw error(
      'recovery-evidence-storage',
      'recovery artifact reference is outside the recovery namespace',
    );
  }
  const filePath = join(sessionDir(ref.projectDir, ref.sessionId), reference.path);
  const projectRelative = relative(ref.projectDir, filePath).split(sep).join('/');
  assertExistingPathConfined(projectRelative, ref.projectDir);
  rejectSymlinkTarget(filePath);
  const bytes = readFileSync(filePath);
  if (bytes.byteLength > MAX_RECOVERY_PAYLOAD_BYTES || sha256Hex(bytes) !== reference.hash) {
    throw error('recovery-evidence-storage', 'recovery artifact failed hash verification');
  }
  return JSON.parse(bytes.toString('utf8'));
}

/** Reconstruct a verified hash-bearing reference from an outbox path. */
export function recoveryReferenceFromPath(
  ref: SessionRef,
  referencePath: string,
): RecoveryEvidenceRef {
  if (!referencePath.startsWith(`${RECOVERY_ROOT}/`)) {
    throw error(
      'recovery-evidence-storage',
      'recovery outbox payload reference is outside the recovery namespace',
    );
  }
  const match = /-([a-f0-9]{64})\.json$/u.exec(referencePath);
  if (match === null || match[1] === undefined) {
    throw error(
      'recovery-evidence-storage',
      'recovery outbox payload reference has no deterministic hash',
    );
  }
  const reference = { revision: 1, hash: match[1], path: referencePath };
  const parsed = recoveryReferenceSchema.safeParse(reference);
  if (!parsed.success)
    throw error('recovery-evidence-storage', 'recovery outbox payload reference is invalid');
  const filePath = join(sessionDir(ref.projectDir, ref.sessionId), referencePath);
  const projectRelative = relative(ref.projectDir, filePath).split(sep).join('/');
  assertExistingPathConfined(projectRelative, ref.projectDir);
  return parsed.data;
}

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

function assertBudgetResourceRecordState(
  kind: RecoveryBudgetResourceKind,
  resource: RecoveryBudgetResource,
): void {
  if (resource.kind !== 'provider-dependent') {
    throw error(
      'recovery-evidence-storage',
      'recovery budget resources must be provider-dependent without USD',
    );
  }
  if (kind === 'reservation') {
    if (resource.observedUsage !== null || resource.resolvedPricing !== null) {
      throw error(
        'recovery-evidence-storage',
        'a reservation hold cannot carry observed usage or resolved pricing',
      );
    }
    return;
  }
  if (resource.observedUsage === null && resource.resolvedPricing === null) {
    throw error(
      'recovery-evidence-storage',
      'a usage reconciliation must observe usage or resolve pricing',
    );
  }
}

export function persistRecoveryBudgetResource(
  ref: SessionRef,
  input: RecoveryBudgetResourceWriteInput,
): Readonly<{ ref: RecoveryEvidenceRef; record: RecoveryEvidenceRecord }> {
  if (input.kind !== 'reservation' && input.kind !== 'usage-reconciliation') {
    throw error('recovery-evidence-storage', 'invalid recovery budget resource record kind');
  }
  const parsed = RecoveryBudgetResourceSchema.safeParse(input.resource);
  if (!parsed.success) {
    throw error('recovery-evidence-storage', 'recovery budget resource payload is invalid');
  }
  assertBudgetResourceRecordState(input.kind, parsed.data);
  return writeRecoveryEvidence(ref, {
    epochId: input.epochId,
    kind: input.kind,
    operationId: input.operationId,
    payload: parsed.data,
    after: input.after ?? null,
  });
}

export function readRecoveryBudgetResources(
  ref: SessionRef,
  epochId: string,
  operationId: string,
): readonly RecoveryBudgetResourceRecord[] {
  assertRecoveryIdentifier(epochId, 'epoch id');
  assertRecoveryIdentifier(operationId, 'operation id');
  const records: RecoveryBudgetResourceRecord[] = [];
  for (const record of readRecoveryJournal(ref).records) {
    if (
      record.epochId !== epochId ||
      record.operationId !== operationId ||
      (record.kind !== 'reservation' && record.kind !== 'usage-reconciliation')
    ) {
      continue;
    }
    const parsed = RecoveryBudgetResourceSchema.safeParse(
      readRecoveryArtifact(ref, recoveryReferenceFromPath(ref, record.payloadRef)),
    );
    if (!parsed.success) {
      throw error('recovery-evidence-storage', 'recovery budget resource payload is invalid');
    }
    assertBudgetResourceRecordState(record.kind, parsed.data);
    records.push({ kind: record.kind, resource: parsed.data, recordHash: record.recordHash });
  }
  return records;
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

function manifestHash(manifest: Omit<RecoveryEpochManifest, 'manifestHash'>): string {
  return sha256Hex(canonicalJSON(manifest));
}

function writeManifestExclusive(
  ref: SessionRef,
  manifest: RecoveryEpochManifest,
): RecoveryEpochManifest {
  const parsed = recoveryManifestSchema.safeParse(manifest);
  if (!parsed.success)
    throw error('recovery-evidence-storage', 'recovery epoch manifest failed its bounded schema');
  const filePath = recoveryManifestPath(ref, manifest.epochId);
  const bytes = Buffer.from(`${canonicalJSON(parsed.data)}\n`, 'utf8');
  if (existsSync(filePath)) {
    rejectSymlinkTarget(filePath);
    const existing = recoveryManifestSchema.safeParse(JSON.parse(readFileSync(filePath, 'utf8')));
    if (!existing.success || canonicalJSON(existing.data) !== canonicalJSON(parsed.data)) {
      throw error('recovery-evidence-storage', 'recovery epoch manifest is immutable');
    }
    return existing.data;
  }
  writeCreateExclusive(ref, filePath, bytes);
  return parsed.data;
}

export function readRecoveryEpochManifest(
  ref: SessionRef,
  epochId: string,
): RecoveryEpochManifest | null {
  const filePath = recoveryManifestPath(ref, epochId);
  if (!existsSync(filePath)) return null;
  const projectRelative = relative(ref.projectDir, filePath).split(sep).join('/');
  assertExistingPathConfined(projectRelative, ref.projectDir);
  rejectSymlinkTarget(filePath);
  const parsed = recoveryManifestSchema.safeParse(JSON.parse(readFileSync(filePath, 'utf8')));
  if (!parsed.success)
    throw error('recovery-evidence-storage', 'recovery epoch manifest is invalid');
  if (parsed.data.outbox.some((entry) => !isRecoveryPayloadPath(entry.payloadRef))) {
    throw error(
      'recovery-evidence-storage',
      'recovery epoch manifest has an out-of-namespace outbox reference',
    );
  }
  const { manifestHash: supplied, ...withoutHash } = parsed.data;
  if (manifestHash(withoutHash) !== supplied)
    throw error('recovery-evidence-storage', 'recovery epoch manifest hash mismatch');
  return parsed.data;
}

export function closeRecoveryEpoch(
  ref: SessionRef,
  input: RecoveryEpochCloseInput,
): RecoveryEpochManifest {
  const existing = readRecoveryEpochManifest(ref, input.epochId);
  if (existing !== null) {
    if (
      existing.disposition !== input.disposition ||
      existing.headHash !== input.headHash ||
      existing.closedAt !== input.closedAt ||
      canonicalJSON(existing.outbox) !== canonicalJSON(input.outbox ?? [])
    ) {
      throw error(
        'recovery-evidence-storage',
        'recovery epoch is already closed with a different disposition',
      );
    }
    return existing;
  }
  assertRecoveryHash(input.headHash, 'epoch head hash');
  const closure = writeRecoveryEvidence(ref, {
    epochId: input.epochId,
    kind: 'epoch-closed',
    eventId: `epoch-closed-${sha256Hex(canonicalJSON({ epochId: input.epochId })).slice(0, 48)}`,
    payload: {
      disposition: input.disposition,
      closedAt: input.closedAt,
      headHash: input.headHash,
    },
    after: null,
  });
  const withoutHash: Omit<RecoveryEpochManifest, 'manifestHash'> = {
    version: 1,
    sessionId: ref.sessionId,
    epochId: input.epochId,
    disposition: input.disposition,
    closedAt: input.closedAt,
    headHash: input.headHash,
    journalHead: closure.record.recordHash,
    sidecarNamespace: `${RECOVERY_ROOT}/${RECOVERY_EPOCHS_DIR}/${input.epochId}/${RECOVERY_SIDECAR_DIR}`,
    outbox: [...(input.outbox ?? [])],
  };
  if (withoutHash.outbox.some((entry) => !isRecoveryPayloadPath(entry.payloadRef))) {
    throw error(
      'recovery-evidence-storage',
      'recovery epoch outbox reference is outside the recovery namespace',
    );
  }
  return writeManifestExclusive(ref, {
    ...withoutHash,
    manifestHash: manifestHash(withoutHash),
  });
}

export function writeRecoverySidecar(
  ref: SessionRef,
  input: RecoverySidecarWriteInput,
): RecoverySidecarResult {
  const manifest = readRecoveryEpochManifest(ref, input.epochId);
  if (manifest === null) throw error('recovery-evidence-storage', 'recovery epoch is not closed');
  const { bytes, hash } = canonicalPayload(input.payload);
  const eventId = `sidecar-${sha256Hex(
    canonicalJSON({
      epochId: input.epochId,
      operationId: input.operationId,
      kind: input.kind,
      hash,
    }),
  ).slice(0, 48)}`;
  const filePath = recoverySidecarPath(ref, input.epochId, input.operationId, input.kind, hash);
  writeCreateExclusive(ref, filePath, bytes);
  const payload = artifactRef(ref, filePath, hash);
  const record = appendRecoveryRecord({
    ref,
    epochId: input.epochId,
    kind: input.kind,
    operationId: input.operationId,
    eventId,
    payloadRef: payload,
    refs: [manifest.manifestHash, ...(input.intentHash === undefined ? [] : [input.intentHash])],
    after: null,
  });
  return { ref: payload, record, manifest };
}

export function replayClosedRecovery(
  ref: SessionRef,
  input: Readonly<{ epochId: string; operationId: string; intentHash?: string | undefined }>,
): RecoveryReplayResult {
  const manifest = readRecoveryEpochManifest(ref, input.epochId);
  if (manifest === null) throw error('recovery-evidence-storage', 'recovery epoch is not closed');
  const journal = readRecoveryJournal(ref);
  const receipt =
    [...journal.records]
      .reverse()
      .find(
        (record) =>
          record.epochId === input.epochId &&
          record.operationId === input.operationId &&
          ['receipt', 'outcome', 'provider-failure', 'storage-failure', 'rejection'].includes(
            record.kind,
          ),
      ) ?? null;
  const sidecar = writeRecoverySidecar(ref, {
    epochId: input.epochId,
    operationId: input.operationId,
    kind: 'replay',
    payload: {
      operationId: input.operationId,
      intentHash: input.intentHash ?? null,
      receipt: receipt?.recordHash ?? null,
    },
    intentHash: input.intentHash,
  });
  return { manifest, receipt, sidecar };
}
