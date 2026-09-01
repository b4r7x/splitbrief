import { sha256Hex } from '../../../utils/sha256.js';
import { error } from '../../../utils/error.js';
import { WORKFLOW_STATE_VERSION, WorkflowStateSchema } from '../../schemas/workflow.js';
import type { WorkflowState } from '../../schemas/workflow.js';
import {
  NormalBriefRecoveryV1Schema,
  StorageBlockedBriefRecoveryV1Schema,
  type BriefRecoveryV1,
  type NormalBriefRecoveryV1,
  type StorageBlockedBriefRecoveryV1,
} from '../../schemas/brief-recovery/document.js';
import type { BriefQualityIssue, EvidenceRef } from '../../schemas/brief-recovery/primitives.js';
import type { SessionRef } from '../../types/session-ref.js';
import { isQueuedMessagePendingDelivery } from '../../queue-state.js';
import {
  LEGACY_DEFAULT_RULE_VERSION,
  LEGACY_DEFAULT_TIMESTAMP,
  legacyQualityReportSchema,
  legacyWorkflowStateSchema,
  type LegacyQualityReport,
  type LegacyWorkflowState,
} from './legacy-state.js';
import type { MigrationArtifacts } from './artifacts.js';

export type LegacyStateMigrationInput = Readonly<{
  ref: SessionRef;
  state: LegacyWorkflowState;
  briefBytes: Uint8Array | null;
  reportBytes: Uint8Array | null;
  ownerId: string;
  fence: number;
  stateRevision: number;
}>;

function migrationEpoch(ref: SessionRef, state: LegacyWorkflowState): string {
  const seed = `${ref.sessionId}\u0000${state.startedAt}\u0000${state.feature}`;
  return `legacy-${sha256Hex(Buffer.from(seed, 'utf8')).slice(0, 48)}`;
}

function migrationTimestamp(state: LegacyWorkflowState): string {
  return state.startedAt.length > 0 ? state.startedAt : LEGACY_DEFAULT_TIMESTAMP;
}

function migrationMode(state: LegacyWorkflowState): 'standard' | 'speckit' | 'quick' {
  return state.mode ?? 'standard';
}

function migrationEntry(state: LegacyWorkflowState): 'initial' | 'rewind' {
  return state.rewindPending === undefined ? 'initial' : 'rewind';
}

function migrationContinuation(state: LegacyWorkflowState): NormalBriefRecoveryV1['continuation'] {
  const mode = migrationMode(state);
  const entry = migrationEntry(state);
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
    const textHash = sha256Hex(Buffer.from(message.text, 'utf8'));
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
  return { revision, hash: sha256Hex(reportBytes), path: 'brief-quality.json' };
}

function briefRef(briefBytes: Uint8Array, revision: number): EvidenceRef {
  return { revision, hash: sha256Hex(briefBytes), path: 'tasks.md' };
}

function storageBlockedRecovery(
  input: Readonly<{
    state: LegacyWorkflowState;
    ref: SessionRef;
    artifact: 'tasks.md' | 'brief-quality.json';
    ownerId: string;
    fence: number;
    stateRevision: number;
  }>,
): StorageBlockedBriefRecoveryV1 {
  const { state, ref, artifact, ownerId, fence, stateRevision } = input;
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
    evidenceHead: sha256Hex(
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
    evidenceHead: sha256Hex(Buffer.from(`${activeBrief.hash}\u0000${reportEvidence.hash}`, 'utf8')),
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
    briefHash: input.briefBytes === null ? null : sha256Hex(input.briefBytes),
    reportHash: input.reportBytes === null ? null : sha256Hex(input.reportBytes),
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
      recovery = storageBlockedRecovery({
        state: parsedState,
        ref: input.ref,
        artifact: completeArtifacts.invalidArtifact,
        ownerId: input.ownerId,
        fence: input.fence,
        stateRevision: input.stateRevision,
      });
    } else {
      try {
        recovery = normalRecovery(parsedState, input.ref, completeArtifacts);
      } catch {
        recovery = storageBlockedRecovery({
          state: parsedState,
          ref: input.ref,
          artifact: 'brief-quality.json',
          ownerId: input.ownerId,
          fence: input.fence,
          stateRevision: input.stateRevision,
        });
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
