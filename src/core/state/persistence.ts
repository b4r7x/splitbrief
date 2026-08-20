import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
  type BigIntStats,
} from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { WorkflowState } from '../schemas/workflow.js';
import {
  ChangedFilesBaselineSchema,
  DiscoveredValidationSchema,
  QueuedMessageSchema,
  WorkflowStateSchema,
  WORKFLOW_STATE_VERSION,
} from '../schemas/workflow.js';
import { PhaseSchema, ApproveLevelSchema, WorkflowModeSchema } from '../schemas/enums.js';
import { TaskSchema } from '../schemas/task.js';
import { TaskTokenUsageSchema, TokenUsageSchema } from '../schemas/tokens.js';
import { RecoveryIssueSchema } from '../schemas/recovery/schemas.js';
import { topoSort } from './topo-sort.js';
import {
  type BriefQualityIssue,
  type BriefRecoveryV1,
  type EvidenceRef,
  type NormalBriefRecoveryV1,
  type StorageBlockedBriefRecoveryV1,
  NormalBriefRecoveryV1Schema,
  StorageBlockedBriefRecoveryV1Schema,
} from '../schemas/brief-recovery.js';
import type { SessionRef } from '../types/session-ref.js';
import { SPLITBRIEF_DIR, SESSIONS_DIR, STATE_FILE, sessionDir } from '../paths.js';
import type {
  ResumeLoadAuthority,
  ResumeLoadInput,
  ResumeLoadResult,
  ResumeReadPermit,
  StateAuthorityCandidate,
  StateAuthorityReceipt,
} from './types.js';
import { narrowRecord } from '../../utils/type-guards.js';
import { error, matches } from '../../utils/error.js';
import { rejectSymlinkTarget } from '../../lib/fs.js';
import {
  confinedAtomicWriteFileSync,
  confinedEnsureDir,
  type ConfigRevision,
  type ExpectedConfigRevision,
} from '../../lib/confined-fs.js';
import { SECURE_FILE_MODE } from '../../lib/fs.js';
import { assertExistingPathConfined } from '../../lib/path-confinement.js';
import { warnStderr } from '../../lib/warn.js';
import { assertSessionDirConfined } from '../sessions/confinement.js';
import { isQueuedMessagePendingDelivery } from '../queue-state.js';

type StateCacheEntry = { mtimeMs: number; size: number; state: WorkflowState };

const STATE_CACHE_MAX_ENTRIES = 64;
const stateCache = new Map<string, StateCacheEntry>();
const LEGACY_STATE_VERSION = 3;
const LEGACY_DEFAULT_RULE_VERSION = 'brief-quality-v1';
const LEGACY_DEFAULT_TIMESTAMP = '1970-01-01T00:00:00.000Z';

const legacyWorkflowStateSchema = z
  .object({
    stateVersion: z.literal(LEGACY_STATE_VERSION),
    phase: PhaseSchema,
    feature: z.string(),
    currentTaskIndex: z.number().int().nonnegative(),
    attempt: z.number().int().nonnegative(),
    tasks: z.array(TaskSchema),
    plannerSessionId: z.string().nullable().optional(),
    startedAt: z.string(),
    tokenUsage: TokenUsageSchema,
    taskBreakdowns: z.array(TaskTokenUsageSchema).optional(),
    plannerTool: z.string().optional(),
    plannerModel: z.string().optional(),
    implementerTool: z.string().optional(),
    implementerModel: z.string().optional(),
    mode: WorkflowModeSchema.optional(),
    approve: ApproveLevelSchema.optional(),
    selectedSkills: z.array(z.string()).optional(),
    awaitingContinue: z.boolean().default(false),
    budgetPauseAcknowledgedAtCost: z.number().optional(),
    messageQueue: z.array(QueuedMessageSchema).default([]),
    rewindPending: z
      .object({
        target: z.enum(['spec', 'plan']),
        comment: z.string().optional(),
      })
      .optional(),
    changedFilesBaseline: ChangedFilesBaselineSchema.optional(),
    pendingRecovery: RecoveryIssueSchema.optional(),
    discoveredValidation: DiscoveredValidationSchema.optional(),
    external: z.record(z.string(), z.unknown()).optional(),
  })
  .superRefine((state, ctx) => {
    try {
      topoSort(state.tasks);
    } catch (cause) {
      ctx.addIssue({
        code: 'custom',
        path: ['tasks'],
        message: cause instanceof Error ? cause.message : 'Invalid task graph',
      });
    }
    const taskCount = state.tasks.length;
    if (
      (state.phase === 'validating-task' || state.phase === 'escalating') &&
      state.currentTaskIndex >= taskCount
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['currentTaskIndex'],
        message: 'currentTaskIndex must reference an existing task in active task phases',
      });
    }
    if (taskCount > 0 && state.currentTaskIndex > taskCount) {
      ctx.addIssue({
        code: 'custom',
        path: ['currentTaskIndex'],
        message: 'currentTaskIndex must not exceed task count',
      });
    }
  });

export type LegacyWorkflowState = z.infer<typeof legacyWorkflowStateSchema>;

export function parseLegacyWorkflowState(value: unknown): LegacyWorkflowState | null {
  const parsed = legacyWorkflowStateSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

const legacyQualityIssueSchema = z
  .object({
    taskId: z.string().nullable(),
    severity: z.enum(['error', 'warning']),
    code: z.string().min(1),
    message: z.string().min(1),
  })
  .strict();

const legacyQualityReportSchema = z
  .object({
    version: z.literal(1),
    passed: z.boolean(),
    score: z.number().finite().min(0).max(1),
    issues: z.array(legacyQualityIssueSchema),
    // A future writer may include this identity. It is not part of the v3
    // report, but accepting it lets migration detect a mismatched artifact
    // rather than silently treating it as a new Brief.
    briefHash: z.string().min(1).optional(),
    ruleVersion: z.string().min(1).optional(),
  })
  .strict();

type LegacyQualityReport = z.infer<typeof legacyQualityReportSchema>;

type RawStateRevision = {
  readonly bytes: Buffer;
  readonly value: unknown;
  readonly revision: ConfigRevision;
  readonly digest: string;
};

type RawStateRead =
  | { readonly kind: 'missing' }
  | {
      readonly kind: 'malformed';
      readonly message: string;
      readonly digest?: string;
      readonly revision?: ConfigRevision;
    }
  | { readonly kind: 'present'; readonly raw: RawStateRevision };

type MigrationArtifacts = {
  readonly briefBytes: Buffer | null;
  readonly reportBytes: Buffer | null;
  readonly briefHash: string | null;
  readonly reportHash: string | null;
  readonly report: LegacyQualityReport | null;
  readonly invalidArtifact: 'tasks.md' | 'brief-quality.json' | null;
};

export type LegacyStateMigrationInput = Readonly<{
  ref: SessionRef;
  state: LegacyWorkflowState;
  briefBytes: Uint8Array | null;
  reportBytes: Uint8Array | null;
  ownerId: string;
  fence: number;
  stateRevision: number;
}>;

export type StateAuthorityFenceCommitInput = Readonly<{
  ref: SessionRef;
  candidate: StateAuthorityCandidate;
  /** Freshly observed parsed state head. */
  rawState?: unknown;
  /** Aliases are accepted for the authority bridge's raw-head vocabulary. */
  stateHead?: unknown;
  head?: unknown;
  rawStateDigest?: string | null;
  expectedRevision?: ExpectedConfigRevision;
  nextFence: number;
}>;

export type StateAuthorityFenceCommitResult =
  | Extract<ResumeLoadAuthority, { kind: 'fenced' }>
  | Extract<ResumeLoadAuthority, { kind: 'read-only' }>
  | Readonly<{
      kind: 'conflict';
      observedRevision: ConfigRevision | null;
      message: string;
    }>
  | Readonly<{
      kind: 'durability-uncertain';
      observedRevision: ConfigRevision;
      message: string;
    }>;

export const statePersistenceError = {
  conflict: (message: string, data?: unknown) => error('state-persistence-conflict', message, data),
  authority: (message: string, data?: unknown) => error('state-authority-mismatch', message, data),
  durabilityUncertain: (message: string, data?: unknown) =>
    error('state-persistence-durability-uncertain', message, data),
  isConflict: matches('state-persistence-conflict'),
  isAuthorityMismatch: matches('state-authority-mismatch'),
  isDurabilityUncertain: matches('state-persistence-durability-uncertain'),
} as const;

function cacheState(filePath: string, entry: StateCacheEntry): void {
  stateCache.delete(filePath);
  stateCache.set(filePath, entry);
  while (stateCache.size > STATE_CACHE_MAX_ENTRIES) {
    const oldest = stateCache.keys().next().value;
    if (oldest === undefined) break;
    stateCache.delete(oldest);
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function revisionFromBytes(bytes: Uint8Array, stat: BigIntStats): ConfigRevision {
  return {
    rawSha256: sha256(bytes),
    fileIdentity: {
      dev: stat.dev,
      ino: stat.ino,
      size: stat.size,
      mtimeNs: stat.mtimeNs,
    },
  };
}

function revisionsMatch(left: ConfigRevision, right: ConfigRevision): boolean {
  return (
    left.rawSha256 === right.rawSha256 &&
    left.fileIdentity.dev === right.fileIdentity.dev &&
    left.fileIdentity.ino === right.fileIdentity.ino &&
    left.fileIdentity.size === right.fileIdentity.size &&
    left.fileIdentity.mtimeNs === right.fileIdentity.mtimeNs
  );
}

function statePath(ref: SessionRef): string {
  const directory = sessionDir(ref.projectDir, ref.sessionId);
  try {
    return join(realpathSync(directory), STATE_FILE);
  } catch {
    return join(directory, STATE_FILE);
  }
}

function readRawState(ref: SessionRef): RawStateRead {
  assertSessionDirConfined(ref.projectDir, ref.sessionId);
  const filePath = statePath(ref);
  if (!existsSync(filePath)) return { kind: 'missing' };

  try {
    rejectSymlinkTarget(filePath);
    assertExistingPathConfined(
      `${SPLITBRIEF_DIR}/${SESSIONS_DIR}/${ref.sessionId}/${STATE_FILE}`,
      ref.projectDir,
    );
  } catch (cause) {
    return {
      kind: 'malformed',
      message: `State file cannot be read safely: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }

  let bytes: Buffer;
  let stat: BigIntStats;
  try {
    bytes = readFileSync(filePath);
    stat = statSync(filePath, { bigint: true });
    if (!stat.isFile()) {
      return { kind: 'malformed', message: 'State path is not a regular file.' };
    }
  } catch (cause) {
    return {
      kind: 'malformed',
      message: `State file cannot be read: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }

  const revision = revisionFromBytes(bytes, stat);
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch (cause) {
    return {
      kind: 'malformed',
      digest: revision.rawSha256,
      revision,
      message: `State file contains invalid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }

  return { kind: 'present', raw: { bytes, value, revision, digest: revision.rawSha256 } };
}

function readArtifact(ref: SessionRef, name: 'tasks.md' | 'brief-quality.json'): Buffer | null {
  const dir = sessionDir(ref.projectDir, ref.sessionId);
  const path = join(dir, name);
  try {
    if (!existsSync(path)) return null;
    rejectSymlinkTarget(path);
    assertExistingPathConfined(
      `${SPLITBRIEF_DIR}/${SESSIONS_DIR}/${ref.sessionId}/${name}`,
      ref.projectDir,
    );
    const stat = lstatSync(path);
    if (!stat.isFile()) return null;
    return readFileSync(path);
  } catch {
    return null;
  }
}

function readMigrationArtifacts(ref: SessionRef): MigrationArtifacts {
  const briefBytes = readArtifact(ref, 'tasks.md');
  if (briefBytes === null) {
    return {
      briefBytes: null,
      reportBytes: null,
      briefHash: null,
      reportHash: null,
      report: null,
      invalidArtifact: 'tasks.md',
    };
  }

  const reportBytes = readArtifact(ref, 'brief-quality.json');
  if (reportBytes === null) {
    return {
      briefBytes,
      reportBytes: null,
      briefHash: sha256(briefBytes),
      reportHash: null,
      report: null,
      invalidArtifact: 'brief-quality.json',
    };
  }

  let reportValue: unknown;
  try {
    reportValue = JSON.parse(reportBytes.toString('utf8'));
  } catch {
    return {
      briefBytes,
      reportBytes,
      briefHash: sha256(briefBytes),
      reportHash: sha256(reportBytes),
      report: null,
      invalidArtifact: 'brief-quality.json',
    };
  }
  const parsed = legacyQualityReportSchema.safeParse(reportValue);
  if (!parsed.success) {
    return {
      briefBytes,
      reportBytes,
      briefHash: sha256(briefBytes),
      reportHash: sha256(reportBytes),
      report: null,
      invalidArtifact: 'brief-quality.json',
    };
  }
  const briefHash = sha256(briefBytes);
  if (parsed.data.briefHash !== undefined && parsed.data.briefHash !== briefHash) {
    return {
      briefBytes,
      reportBytes,
      briefHash,
      reportHash: sha256(reportBytes),
      report: null,
      invalidArtifact: 'brief-quality.json',
    };
  }
  return {
    briefBytes,
    reportBytes,
    briefHash,
    reportHash: sha256(reportBytes),
    report: parsed.data,
    invalidArtifact: null,
  };
}

function migrationEpoch(ref: SessionRef, state: LegacyWorkflowState): string {
  const seed = `${ref.sessionId}\u0000${state.startedAt}\u0000${state.feature}`;
  return `legacy-${sha256(Buffer.from(seed, 'utf8')).slice(0, 48)}`;
}

function migrationTimestamp(state: LegacyWorkflowState): string {
  return state.startedAt.length > 0 ? state.startedAt : LEGACY_DEFAULT_TIMESTAMP;
}

function migrationMode(state: LegacyWorkflowState): 'standard' | 'speckit' | 'instant' | 'quick' {
  return state.mode ?? 'standard';
}

function migrationEntry(state: LegacyWorkflowState): 'initial' | 'rewind' {
  return state.rewindPending === undefined ? 'initial' : 'rewind';
}

function migrationContinuation(state: LegacyWorkflowState): NormalBriefRecoveryV1['continuation'] {
  const mode = migrationMode(state);
  const entry = migrationEntry(state);
  if (mode === 'instant') return { version: 1, kind: 'instant-start', entry };
  if (mode === 'quick') return { version: 1, kind: 'quick-start', entry };
  return { version: 1, kind: 'approval', mode, entry };
}

function migrationOrigin(state: LegacyWorkflowState): NormalBriefRecoveryV1['origin'] {
  return { mode: migrationMode(state), entry: migrationEntry(state) };
}

function migratedInputs(
  state: LegacyWorkflowState,
  epochId: string,
): NormalBriefRecoveryV1['inputs'] {
  return state.messageQueue.map((message, index) => {
    const pending = isQueuedMessagePendingDelivery(message);
    const delivered =
      message.drainedAt !== undefined ||
      message.deliveredViaNative ||
      message.nativeDeliveryState === 'delivered';
    const native =
      message.deliveredViaNative ||
      message.nativeDeliveryState === 'injecting' ||
      message.nativeDeliveryState === 'delivered';
    const inputState = pending ? 'queued' : delivered ? 'applied' : 'held';
    const terminalAt = message.drainedAt ?? message.queuedAt;
    const remoteObservation = inputState === 'held' ? 'possible' : null;
    const textHash = sha256(Buffer.from(message.text, 'utf8'));
    const payloadRef: EvidenceRef = {
      revision: index + 1,
      hash: textHash,
      path: `state.json#messageQueue/${message.id}`,
    };
    return {
      inputId: message.id,
      epochId,
      sequence: index + 1,
      kind: native ? 'native-injection' : 'feedback',
      source: native
        ? 'native-injection'
        : message.origin === 'clarification'
          ? 'interactive'
          : 'typed',
      payloadRef,
      textHash,
      state: inputState,
      operationId: null,
      appliedRevision: inputState === 'applied' ? 1 : null,
      remoteObservation,
      history:
        inputState === 'queued'
          ? [
              {
                state: 'queued',
                at: message.queuedAt,
                operationId: null,
                remoteObservation: null,
              },
            ]
          : [
              {
                state: 'queued',
                at: message.queuedAt,
                operationId: null,
                remoteObservation: null,
              },
              {
                state: inputState,
                at: terminalAt,
                operationId: null,
                remoteObservation,
              },
            ],
    };
  });
}

function mappedIssues(report: LegacyQualityReport): BriefQualityIssue[] {
  return report.issues.map((issue) => ({
    code: issue.code,
    severity: issue.severity,
    taskId: issue.taskId,
    message: issue.message,
  }));
}

function reportRef(reportBytes: Uint8Array, revision: number): EvidenceRef {
  return { revision, hash: sha256(reportBytes), path: 'brief-quality.json' };
}

function briefRef(briefBytes: Uint8Array, revision: number): EvidenceRef {
  return { revision, hash: sha256(briefBytes), path: 'tasks.md' };
}

function storageBlockedRecovery(
  state: LegacyWorkflowState,
  ref: SessionRef,
  artifact: 'tasks.md' | 'brief-quality.json',
  ownerId: string,
  fence: number,
  stateRevision: number,
): StorageBlockedBriefRecoveryV1 {
  const epochId = migrationEpoch(ref, state);
  const timestamp = migrationTimestamp(state);
  const recovery: StorageBlockedBriefRecoveryV1 = {
    version: 1,
    recoveryRevision: 1,
    epochId,
    origin: migrationOrigin(state),
    continuation: migrationContinuation(state),
    status: 'storage-blocked',
    activeBrief: null,
    storageEvidence: { code: 'brief_storage_invalid', artifactRef: artifact },
    evidenceHead: sha256(
      Buffer.from(
        `${ref.sessionId}\u0000${stateRevision}\u0000${fence}\u0000${ownerId}\u0000${timestamp}\u0000${artifact}`,
        'utf8',
      ),
    ),
    outbox: [],
  };
  return StorageBlockedBriefRecoveryV1Schema.parse(recovery);
}

function normalRecovery(
  state: LegacyWorkflowState,
  ref: SessionRef,
  artifacts: MigrationArtifacts,
): NormalBriefRecoveryV1 {
  if (
    artifacts.briefBytes === null ||
    artifacts.reportBytes === null ||
    artifacts.report === null
  ) {
    throw error(
      'state-persistence-invalid-recovery',
      'normalRecovery requires valid Brief and report artifacts',
    );
  }
  const epochId = migrationEpoch(ref, state);
  const activeBrief = briefRef(artifacts.briefBytes, 1);
  const report = artifacts.report;
  const reportEvidence = reportRef(artifacts.reportBytes, 1);
  const issues = mappedIssues(report);
  const hasErrors = issues.some((issue) => issue.severity === 'error');
  const mode = migrationMode(state);
  const automaticPolicy = mode === 'standard' || mode === 'speckit' ? 'existing-one-shot' : 'none';
  const recovery: NormalBriefRecoveryV1 = {
    version: 1,
    recoveryRevision: 1,
    epochId,
    origin: migrationOrigin(state),
    continuation: migrationContinuation(state),
    status: hasErrors ? 'blocked' : 'ready',
    activeBrief,
    matchingReport: {
      briefHash: activeBrief.hash,
      report: reportEvidence,
      ruleVersion: report.ruleVersion ?? LEGACY_DEFAULT_RULE_VERSION,
      issues,
    },
    qualityPolicyVersion: report.ruleVersion ?? LEGACY_DEFAULT_RULE_VERSION,
    automaticRepair: {
      policy: automaticPolicy,
      eligible: automaticPolicy !== 'none',
      // A legacy reviewing-briefs snapshot is already past the planner call.
      // Consuming the allowance here prevents resume from inventing another
      // automatic provider invocation.
      consumed: automaticPolicy !== 'none',
      operationId: null,
    },
    attempts: {},
    activeOperationId: null,
    inputs: migratedInputs(state, epochId),
    nextInputSequence: state.messageQueue.length + 1,
    noProgress: { fingerprint: null, count: 0 },
    evidenceHead: sha256(Buffer.from(`${activeBrief.hash}\u0000${reportEvidence.hash}`, 'utf8')),
    outbox: [],
  };
  return NormalBriefRecoveryV1Schema.parse(recovery);
}

/**
 * Pure v3 → v4 conversion. No authority acquisition, filesystem read, or
 * provider operation belongs here; callers provide the already-read legacy
 * state and evidence bytes plus the fence that will guard its replacement.
 */
export function mapV3StateToV4(input: LegacyStateMigrationInput): WorkflowState {
  const parsedState = legacyWorkflowStateSchema.parse(input.state);
  const artifacts: MigrationArtifacts = {
    briefBytes: input.briefBytes === null ? null : Buffer.from(input.briefBytes),
    reportBytes: input.reportBytes === null ? null : Buffer.from(input.reportBytes),
    briefHash: input.briefBytes === null ? null : sha256(input.briefBytes),
    reportHash: input.reportBytes === null ? null : sha256(input.reportBytes),
    report: null,
    invalidArtifact: null,
  };
  let report: LegacyQualityReport | null = null;
  if (artifacts.reportBytes !== null) {
    try {
      report = legacyQualityReportSchema.parse(JSON.parse(artifacts.reportBytes.toString('utf8')));
    } catch {
      report = null;
    }
  }
  const completeArtifacts: MigrationArtifacts = {
    ...artifacts,
    report,
    invalidArtifact:
      artifacts.briefBytes === null
        ? 'tasks.md'
        : artifacts.reportBytes === null || report === null
          ? 'brief-quality.json'
          : report.briefHash !== undefined && report.briefHash !== artifacts.briefHash
            ? 'brief-quality.json'
            : null,
  };
  let recovery: BriefRecoveryV1 | null = null;
  if (parsedState.phase === 'reviewing-briefs') {
    if (completeArtifacts.invalidArtifact !== null) {
      recovery = storageBlockedRecovery(
        parsedState,
        input.ref,
        completeArtifacts.invalidArtifact,
        input.ownerId,
        input.fence,
        input.stateRevision,
      );
    } else {
      try {
        recovery = normalRecovery(parsedState, input.ref, completeArtifacts);
      } catch {
        recovery = storageBlockedRecovery(
          parsedState,
          input.ref,
          'brief-quality.json',
          input.ownerId,
          input.fence,
          input.stateRevision,
        );
      }
    }
  }
  const legacyQueue = parsedState.messageQueue;
  const migrated = {
    ...parsedState,
    stateVersion: WORKFLOW_STATE_VERSION,
    stateRevision: input.stateRevision,
    stateFence: { token: input.fence, ownerId: input.ownerId },
    messageQueue: recovery !== null && recovery.status !== 'storage-blocked' ? [] : legacyQueue,
    briefRecovery: recovery,
  };
  const validated = WorkflowStateSchema.parse(migrated);
  return validated;
}

function classifyStateVersion(
  raw: unknown,
):
  | { kind: 'malformed'; message: string }
  | { kind: 'future-version'; message: string }
  | { kind: 'v3'; state: LegacyWorkflowState }
  | { kind: 'v4'; state: WorkflowState } {
  const record = narrowRecord(raw);
  if (record === null) return { kind: 'malformed', message: 'State file is not an object.' };
  const stateVersion = record.stateVersion;
  if (typeof stateVersion !== 'number' || !Number.isInteger(stateVersion)) {
    return { kind: 'malformed', message: 'State file has no integer stateVersion.' };
  }
  if (stateVersion > WORKFLOW_STATE_VERSION) {
    return {
      kind: 'future-version',
      message: `State file version ${stateVersion} is newer than supported version ${WORKFLOW_STATE_VERSION}.`,
    };
  }
  if (stateVersion === LEGACY_STATE_VERSION) {
    if (containsFutureNestedVersion(raw)) {
      return {
        kind: 'future-version',
        message: 'State file contains a nested version newer than supported v1 recovery schemas.',
      };
    }
    const parsed = legacyWorkflowStateSchema.safeParse(raw);
    if (!parsed.success) {
      return { kind: 'malformed', message: 'State file failed legacy v3 schema validation.' };
    }
    return { kind: 'v3', state: parsed.data };
  }
  if (stateVersion === WORKFLOW_STATE_VERSION) {
    const parsed = WorkflowStateSchema.safeParse(raw);
    if (!parsed.success) {
      if (containsFutureNestedVersion(raw)) {
        return {
          kind: 'future-version',
          message: `State file contains a nested version newer than supported v1 recovery schemas.`,
        };
      }
      return { kind: 'malformed', message: 'State file failed current v4 schema validation.' };
    }
    return { kind: 'v4', state: parsed.data };
  }
  return {
    kind: 'malformed',
    message: `State file version ${stateVersion} is unsupported; only v3 can be migrated.`,
  };
}

function containsFutureNestedVersion(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsFutureNestedVersion);
  const record = narrowRecord(value);
  if (record === null) return false;
  for (const [key, nested] of Object.entries(record)) {
    if (key === 'version' && typeof nested === 'number' && nested > 1) return true;
    if (containsFutureNestedVersion(nested)) return true;
  }
  return false;
}

function authorityMismatch(message: string, data?: unknown): never {
  throw statePersistenceError.authority(message, data);
}

function assertReceiptForRef(receipt: StateAuthorityReceipt, ref: SessionRef): void {
  if (receipt.sessionId !== ref.sessionId) {
    authorityMismatch('State authority receipt is bound to a different session.', {
      expectedSessionId: ref.sessionId,
      receiptSessionId: receipt.sessionId,
    });
  }
  if (receipt.ownerId.length === 0 || receipt.acquisitionId.length === 0) {
    authorityMismatch('State authority receipt is missing owner or acquisition identity.');
  }
  if (!Number.isInteger(receipt.fence) || receipt.fence < 0) {
    authorityMismatch('State authority receipt has an invalid fence token.');
  }
  if (!Number.isInteger(receipt.stateRevision) || receipt.stateRevision < 0) {
    authorityMismatch('State authority receipt has an invalid state revision.');
  }
}

function assertCandidateForRef(candidate: StateAuthorityCandidate, ref: SessionRef): void {
  if (candidate.kind !== 'candidate' || candidate.sessionId !== ref.sessionId) {
    authorityMismatch('State authority candidate is bound to a different session.');
  }
  if (candidate.ownerId.length === 0 || candidate.acquisitionId.length === 0) {
    authorityMismatch('State authority candidate is missing owner or acquisition identity.');
  }
  if (!Number.isInteger(candidate.fence) || candidate.fence < 0) {
    authorityMismatch('State authority candidate has an invalid fence token.');
  }
  if (!Number.isInteger(candidate.stateRevision) || candidate.stateRevision < 0) {
    authorityMismatch('State authority candidate has an invalid state revision.');
  }
  if (candidate.stateDigest !== null) {
    authorityMismatch('State authority candidate must not carry a usable state digest.');
  }
}

function permitFor(
  ref: SessionRef,
  acquisitionId: string,
  digest: string | null,
): ResumeReadPermit {
  return {
    kind: 'read-only-permit',
    sessionId: ref.sessionId,
    acquisitionId,
    rawStateDigest: digest,
  };
}

const consumedReadOnlyPermits = new Set<string>();

function permitKey(permit: ResumeReadPermit): string {
  return `${permit.sessionId}\u0000${permit.acquisitionId}\u0000${permit.rawStateDigest ?? ''}`;
}

function invalidResult(code: 'malformed' | 'future-version', message: string): ResumeLoadResult {
  return { kind: 'invalid', code, message };
}

function expectedRevisionOrCurrent(
  supplied: ExpectedConfigRevision | undefined,
  current: ConfigRevision,
): ConfigRevision {
  return supplied ?? current;
}

export function serializedState(state: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

export function workflowStateDigest(state: WorkflowState): string {
  return createHash('sha256').update(serializedState(state)).digest('hex');
}

function cacheRevision(filePath: string, revision: ConfigRevision, state: WorkflowState): void {
  cacheState(filePath, {
    mtimeMs: Number(revision.fileIdentity.mtimeNs / 1_000_000n),
    size: Number(revision.fileIdentity.size),
    state,
  });
}

function stableJson(value: unknown): string | null {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : null;
  if (Array.isArray(value)) {
    const parts = value.map(stableJson);
    return parts.every((part) => part !== null) ? `[${parts.join(',')}]` : null;
  }
  const record = narrowRecord(value);
  if (record === null) return null;
  const entries: string[] = [];
  for (const key of Object.keys(record).sort()) {
    const part = stableJson(record[key]);
    if (part === null) return null;
    entries.push(`${JSON.stringify(key)}:${part}`);
  }
  return `{${entries.join(',')}}`;
}

function rawHeadMatches(rawHead: unknown, raw: RawStateRevision): boolean {
  if (rawHead instanceof Uint8Array) return sha256(rawHead) === raw.digest;
  if (typeof rawHead === 'string') return sha256(Buffer.from(rawHead, 'utf8')) === raw.digest;
  const record = narrowRecord(rawHead);
  if (record !== null) {
    const suppliedDigest = record.rawStateDigest ?? record.digest;
    if (typeof suppliedDigest === 'string') return suppliedDigest === raw.digest;
    const suppliedBytes = record.bytes;
    if (suppliedBytes instanceof Uint8Array) return sha256(suppliedBytes) === raw.digest;
    const suppliedValue = record.value ?? record.state ?? rawHead;
    const expected = stableJson(raw.value);
    const observed = stableJson(suppliedValue);
    return expected !== null && observed !== null && expected === observed;
  }
  return false;
}

function cacheRawState(filePath: string, raw: RawStateRevision, state: WorkflowState): void {
  const mtimeNs = raw.revision.fileIdentity.mtimeNs;
  cacheState(filePath, {
    mtimeMs: Number(mtimeNs / 1_000_000n),
    size: Number(raw.revision.fileIdentity.size),
    state,
  });
}

function receiptFrom(
  candidate: StateAuthorityCandidate,
  ref: SessionRef,
  state: WorkflowState,
  digest: string,
  fence: number,
): StateAuthorityReceipt {
  return {
    kind: 'usable',
    sessionId: ref.sessionId,
    ownerId: candidate.ownerId,
    pid: candidate.pid,
    processStart: candidate.processStart,
    runId: candidate.runId,
    acquisitionId: candidate.acquisitionId,
    fence,
    stateRevision: state.stateRevision ?? 0,
    stateDigest: digest,
  };
}

function receiptFromExisting(
  receipt: StateAuthorityReceipt,
  ref: SessionRef,
  state: WorkflowState,
  digest: string,
): StateAuthorityReceipt {
  return {
    ...receipt,
    sessionId: ref.sessionId,
    stateRevision: state.stateRevision ?? receipt.stateRevision,
    stateDigest: digest,
  };
}

function migrationStateFromReceipt(
  ref: SessionRef,
  state: LegacyWorkflowState,
  artifacts: MigrationArtifacts,
  receipt: StateAuthorityReceipt,
  expectedRevision: ConfigRevision,
): StateAuthorityFenceCommitResult {
  if (receipt.fence < 1) {
    authorityMismatch('A v3 migration requires a positive authority fence.');
  }
  if (receipt.stateDigest !== expectedRevision.rawSha256) {
    authorityMismatch('State authority receipt does not match the v3 state bytes.', {
      expectedDigest: expectedRevision.rawSha256,
      receiptDigest: receipt.stateDigest,
    });
  }
  const mapped = mapV3StateToV4({
    ref,
    state,
    briefBytes: artifacts.briefBytes,
    reportBytes: artifacts.reportBytes,
    ownerId: receipt.ownerId,
    fence: receipt.fence,
    stateRevision: receipt.stateRevision > 0 ? receipt.stateRevision : 1,
  });
  const path = statePath(ref);
  const write = confinedAtomicWriteFileSync(path, serializedState(mapped), {
    expectedRevision,
    mode: SECURE_FILE_MODE,
  });
  if (write.kind === 'conflict') {
    return {
      kind: 'conflict',
      observedRevision: write.observedRevision,
      message: 'v3 migration lost the expected-revision compare-and-swap.',
    };
  }
  if (write.kind === 'durability-uncertain') {
    return {
      kind: 'durability-uncertain',
      observedRevision: write.observedRevision,
      message: 'v3 migration completed but durable verification is uncertain.',
    };
  }
  const digest = write.revision.rawSha256;
  return {
    kind: 'fenced',
    receipt: receiptFromExisting(receipt, ref, mapped, digest),
    promotedFromVersion: 3,
  };
}

function migrateV3WithReceipt(
  ref: SessionRef,
  raw: RawStateRevision,
  state: LegacyWorkflowState,
  receipt: StateAuthorityReceipt,
): StateAuthorityFenceCommitResult {
  const artifacts = readMigrationArtifacts(ref);
  return migrationStateFromReceipt(ref, state, artifacts, receipt, raw.revision);
}

/**
 * Commit the authority fence and, when needed, the v3 promotion in one state
 * CAS. This is deliberately a persistence port: it does not acquire or
 * release the session authority directory.
 */
export function commitStateAuthorityFence(
  input: StateAuthorityFenceCommitInput,
): StateAuthorityFenceCommitResult {
  assertSessionDirConfined(input.ref.projectDir, input.ref.sessionId);
  assertCandidateForRef(input.candidate, input.ref);
  if (!Number.isInteger(input.nextFence) || input.nextFence < 0) {
    authorityMismatch('Next state fence must be a non-negative integer.');
  }
  const rawResult = readRawState(input.ref);
  if (rawResult.kind === 'missing') {
    return {
      kind: 'read-only',
      permit: permitFor(input.ref, input.candidate.acquisitionId, null),
    };
  }
  if (rawResult.kind === 'malformed') {
    return {
      kind: 'read-only',
      permit: permitFor(input.ref, input.candidate.acquisitionId, rawResult.digest ?? null),
    };
  }
  const raw = rawResult.raw;
  if (input.rawStateDigest !== undefined && input.rawStateDigest !== raw.digest) {
    return {
      kind: 'conflict',
      observedRevision: raw.revision,
      message: 'Fresh state digest does not match the state head on disk.',
    };
  }
  const suppliedHead =
    input.rawState !== undefined
      ? input.rawState
      : input.stateHead !== undefined
        ? input.stateHead
        : input.head;
  if (suppliedHead !== undefined && !rawHeadMatches(suppliedHead, raw)) {
    return {
      kind: 'conflict',
      observedRevision: raw.revision,
      message: 'Fresh state head does not match the state head on disk.',
    };
  }
  const classification = classifyStateVersion(raw.value);
  if (classification.kind === 'malformed' || classification.kind === 'future-version') {
    return {
      kind: 'read-only',
      permit: permitFor(input.ref, input.candidate.acquisitionId, raw.digest),
    };
  }
  const expectedRevision = expectedRevisionOrCurrent(input.expectedRevision, raw.revision);
  if (!revisionsMatch(expectedRevision, raw.revision)) {
    return {
      kind: 'conflict',
      observedRevision: raw.revision,
      message: 'Fresh state revision does not match the state head on disk.',
    };
  }

  if (classification.kind === 'v3') {
    if (input.candidate.fence !== 0 || input.candidate.stateRevision !== 0) {
      return {
        kind: 'conflict',
        observedRevision: raw.revision,
        message: 'Authority candidate is stale for the legacy v3 state head.',
      };
    }
    if (input.nextFence < 1) {
      authorityMismatch('The first v4 fence must be at least one.');
    }
    const artifacts = readMigrationArtifacts(input.ref);
    const mapped = mapV3StateToV4({
      ref: input.ref,
      state: classification.state,
      briefBytes: artifacts.briefBytes,
      reportBytes: artifacts.reportBytes,
      ownerId: input.candidate.ownerId,
      fence: input.nextFence,
      stateRevision: input.candidate.stateRevision > 0 ? input.candidate.stateRevision : 1,
    });
    const write = confinedAtomicWriteFileSync(statePath(input.ref), serializedState(mapped), {
      expectedRevision,
      mode: SECURE_FILE_MODE,
    });
    if (write.kind === 'conflict') {
      return {
        kind: 'conflict',
        observedRevision: write.observedRevision,
        message: 'v3 promotion lost the expected-revision compare-and-swap.',
      };
    }
    if (write.kind === 'durability-uncertain') {
      return {
        kind: 'durability-uncertain',
        observedRevision: write.observedRevision,
        message: 'v3 promotion completed but durable verification is uncertain.',
      };
    }
    return {
      kind: 'fenced',
      receipt: receiptFrom(
        input.candidate,
        input.ref,
        mapped,
        write.revision.rawSha256,
        input.nextFence,
      ),
      promotedFromVersion: 3,
    };
  }

  const current = classification.state;
  const currentFence = current.stateFence?.token ?? 0;
  const currentRevision = current.stateRevision ?? 0;
  if (input.candidate.fence !== currentFence) {
    return {
      kind: 'conflict',
      observedRevision: raw.revision,
      message: 'Authority candidate is stale for the current state fence.',
    };
  }
  if (input.candidate.stateRevision !== currentRevision) {
    return {
      kind: 'conflict',
      observedRevision: raw.revision,
      message: 'Authority candidate is stale for the current state revision.',
    };
  }
  if (input.nextFence <= currentFence) {
    return {
      kind: 'conflict',
      observedRevision: raw.revision,
      message: 'Authority fence must advance monotonically.',
    };
  }
  const fencedState = WorkflowStateSchema.parse({
    ...current,
    stateRevision: currentRevision + 1,
    stateFence: { token: input.nextFence, ownerId: input.candidate.ownerId },
  });
  const write = confinedAtomicWriteFileSync(statePath(input.ref), serializedState(fencedState), {
    expectedRevision,
    mode: SECURE_FILE_MODE,
  });
  if (write.kind === 'conflict') {
    return {
      kind: 'conflict',
      observedRevision: write.observedRevision,
      message: 'Fence advancement lost the expected-revision compare-and-swap.',
    };
  }
  if (write.kind === 'durability-uncertain') {
    return {
      kind: 'durability-uncertain',
      observedRevision: write.observedRevision,
      message: 'Fence advancement completed but durable verification is uncertain.',
    };
  }
  return {
    kind: 'fenced',
    receipt: receiptFrom(
      input.candidate,
      input.ref,
      fencedState,
      write.revision.rawSha256,
      input.nextFence,
    ),
    promotedFromVersion: null,
  };
}

export function loadStateForResume(input: ResumeLoadInput): ResumeLoadResult {
  assertSessionDirConfined(input.ref.projectDir, input.ref.sessionId);
  const authority = input.authority;
  if (authority.kind === 'fenced') assertReceiptForRef(authority.receipt, input.ref);
  const permit = authority.kind === 'read-only' ? authority.permit : null;
  if (permit !== null) {
    if (permit.sessionId !== input.ref.sessionId || permit.acquisitionId.length === 0) {
      return invalidResult('malformed', 'Read-only resume permit is not bound to this session.');
    }
    if (consumedReadOnlyPermits.has(permitKey(permit))) {
      return invalidResult('malformed', 'Read-only resume permit has already been consumed.');
    }
  }

  try {
    const rawResult = readRawState(input.ref);
    if (rawResult.kind === 'missing') {
      if (permit !== null && permit.rawStateDigest !== null) {
        return invalidResult(
          'malformed',
          'Read-only permit expected a state head that is missing.',
        );
      }
      return { kind: 'missing' };
    }
    if (rawResult.kind === 'malformed') return invalidResult('malformed', rawResult.message);
    const raw = rawResult.raw;
    if (permit !== null) {
      if (permit.rawStateDigest !== raw.digest) {
        return invalidResult(
          'malformed',
          'State bytes changed after the read-only permit was issued.',
        );
      }
    }
    const classification = classifyStateVersion(raw.value);
    if (classification.kind === 'malformed')
      return invalidResult('malformed', classification.message);
    if (classification.kind === 'future-version') {
      return invalidResult('future-version', classification.message);
    }
    if (permit !== null) {
      return invalidResult(
        'malformed',
        'A read-only resume permit cannot authorize migration or loading a valid state.',
      );
    }
    if (authority.kind !== 'fenced') {
      return invalidResult('malformed', 'Resume loading requires a usable fenced authority.');
    }
    const receipt = authority.receipt;

    if (classification.kind === 'v4') {
      const current = classification.state;
      if (current.stateFence === undefined) {
        return invalidResult('malformed', 'Current v4 state has no persisted fence.');
      }
      if (receipt.stateDigest !== raw.digest) {
        return invalidResult(
          'malformed',
          'State authority receipt digest does not match the current v4 state.',
        );
      }
      if (receipt.stateRevision !== current.stateRevision) {
        return invalidResult(
          'malformed',
          'State authority receipt revision does not match the current v4 state.',
        );
      }
      if (
        receipt.fence !== current.stateFence.token ||
        receipt.ownerId !== current.stateFence.ownerId
      ) {
        return invalidResult(
          'malformed',
          'State authority receipt fence does not match the current v4 state.',
        );
      }
      cacheRawState(statePath(input.ref), raw, current);
      return { kind: 'loaded', state: current, migrated: authority.promotedFromVersion === 3 };
    }

    const migrated = migrateV3WithReceipt(input.ref, raw, classification.state, authority.receipt);
    if (migrated.kind === 'conflict') {
      throw statePersistenceError.conflict(migrated.message, migrated);
    }
    if (migrated.kind === 'durability-uncertain') {
      throw statePersistenceError.durabilityUncertain(migrated.message, migrated);
    }
    if (migrated.kind !== 'fenced') {
      throw statePersistenceError.authority('v3 migration did not produce a usable receipt.');
    }
    const finalRead = readRawState(input.ref);
    if (finalRead.kind !== 'present') {
      throw statePersistenceError.durabilityUncertain(
        'v3 migration committed but the resulting state cannot be read.',
      );
    }
    const finalClassification = classifyStateVersion(finalRead.raw.value);
    if (finalClassification.kind !== 'v4') {
      throw statePersistenceError.durabilityUncertain(
        'v3 migration committed a state that is not a valid v4 snapshot.',
      );
    }
    cacheRawState(statePath(input.ref), finalRead.raw, finalClassification.state);
    return { kind: 'loaded', state: finalClassification.state, migrated: true };
  } finally {
    if (permit !== null) consumedReadOnlyPermits.add(permitKey(permit));
  }
}

export function saveState(ref: SessionRef, state: WorkflowState): void {
  assertSessionDirConfined(ref.projectDir, ref.sessionId);
  const parsed =
    state.stateVersion === WORKFLOW_STATE_VERSION
      ? WorkflowStateSchema.safeParse(state)
      : state.stateVersion === LEGACY_STATE_VERSION
        ? legacyWorkflowStateSchema.safeParse(state)
        : null;
  if (!parsed?.success) return;

  const current = readRawState(ref);
  if (current.kind === 'malformed' && current.revision === undefined) return;
  const expectedRevision =
    current.kind === 'present'
      ? current.raw.revision
      : current.kind === 'malformed'
        ? (current.revision ?? null)
        : null;

  confinedEnsureDir(ref.projectDir, join(SPLITBRIEF_DIR, SESSIONS_DIR, ref.sessionId));
  const filePath = statePath(ref);
  const write = confinedAtomicWriteFileSync(filePath, serializedState(parsed.data), {
    expectedRevision,
    mode: SECURE_FILE_MODE,
  });
  if (write.kind !== 'written') return;
  if (state.stateVersion !== WORKFLOW_STATE_VERSION) {
    stateCache.delete(filePath);
    return;
  }
  cacheRevision(filePath, write.revision, parsed.data);
}

export function loadState(ref: SessionRef): WorkflowState | null {
  const dir = sessionDir(ref.projectDir, ref.sessionId);
  const filePath = join(dir, STATE_FILE);
  if (!existsSync(filePath)) return null;
  try {
    rejectSymlinkTarget(filePath);
  } catch {
    warnStderr('Warning: refusing to read state through symlink, ignoring');
    return null;
  }
  assertExistingPathConfined(
    `${SPLITBRIEF_DIR}/${SESSIONS_DIR}/${ref.sessionId}/${STATE_FILE}`,
    ref.projectDir,
  );
  let stat: ReturnType<typeof statSync>;
  let raw: unknown;
  try {
    stat = statSync(filePath);
    const cached = stateCache.get(filePath);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      cacheState(filePath, cached);
      return cached.state;
    }
    raw = JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    warnStderr('Warning: corrupt state file, ignoring');
    return null;
  }
  const record = narrowRecord(raw);
  if (!record) {
    warnStderr('Warning: state file is not an object, ignoring');
    return null;
  }
  if (record.stateVersion !== WORKFLOW_STATE_VERSION) {
    warnStderr(
      `Warning: state file version ${String(record.stateVersion)} is incompatible with version ${WORKFLOW_STATE_VERSION}, ignoring`,
    );
    return null;
  }
  const result = WorkflowStateSchema.safeParse(raw);
  if (!result.success) {
    warnStderr('Warning: state file failed schema validation, ignoring');
    return null;
  }
  const state = result.data;
  cacheState(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, state });
  return state;
}
