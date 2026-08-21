import type { Task, TaskId } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type {
  BriefRecoveryStateView,
  BriefRecoveryV1,
} from '../../../core/schemas/brief-recovery.js';
import type {
  BriefOwnerCommitInput,
  BriefOwnerCommitResult,
  BriefOwnerEvent,
  BriefOwnerStatePatch,
} from '../../../core/schemas/brief-owner.js';
import {
  BriefOwnerCommitResultSchema,
  BriefOwnerStatePatchSchema,
  sameExecutionPermit,
} from '../../../core/schemas/brief-owner.js';
import type { WorkflowContext } from '../types.js';
import { publishWarningFromError } from '../events.js';
import { createEvidenceLedger } from '../../../core/evidence/ledger-state.js';
import {
  closeRecoveryEpoch,
  readRecoveryArtifact,
  recoveryReferenceFromPath,
  type RecoveryCheckpoint,
  type RecoveryEvidenceKind,
  type RecoveryEvidenceRecord,
  type RecoveryEpochManifest,
  type RecoveryEvidenceRef,
  type RecoveryOutboxEntry,
  type RecoveryReplayResult,
  type RecoverySidecarResult,
  transactRecoveryEvidence,
  writeRecoverySidecar,
  replayClosedRecovery,
  withRecoveryJournalLock,
} from '../../../core/evidence/ledger-storage.js';
import { mutateEvidenceLedger, readEvidenceLedger } from '../../../core/evidence/ledger-storage.js';
import {
  recordLocalTaskEvidence,
  recordRetryOrEscalationEvidence,
  recordSkippedTaskEvidence,
} from './task.js';
import { recordApprovalEvidence, recordRejectionEvidence } from './approval.js';
import { DEFAULT_WORKFLOW_MODE } from '../../../core/schemas/config.js';
import type { ValidationResult } from '../validation/result.js';
import type {
  ActionClass,
  TaskCompletionMethod,
  TaskStatus,
  WorkflowMode,
} from '../../../core/schemas/enums.js';
import { PhaseSchema } from '../../../core/schemas/enums.js';
import { hashTaskBrief } from '../../brief-hash.js';
import type { GateDecision } from '../approval/types.js';
import type { EvidenceLedger, EvidenceValidationEntry } from '../../../core/schemas/evidence.js';
import type { SessionRef } from '../../../core/types/session-ref.js';
import type { ConfigRevision } from '../../../lib/confined-fs.js';
import { parseEngineEvent } from '../../events/schema.js';
import type { EventBus } from '../../events/types.js';
import { error } from '../../../utils/error.js';
import {
  commitWorkflowState,
  readWorkflowStateHead,
  revisionsMatch,
  workflowStateRevision,
  type WorkflowStateCommitResult,
} from '../state-ops.js';

export function getOrCreateLedger(opts: {
  ref: SessionRef;
  state: WorkflowState;
  mode?: WorkflowMode | undefined;
}): EvidenceLedger {
  const { ref, state, mode } = opts;
  const existing = readEvidenceLedger(ref);
  const briefHash = hashTaskBrief(state.tasks);
  return (
    existing ??
    createEvidenceLedger({
      sessionId: ref.sessionId,
      feature: state.feature,
      mode: mode ?? DEFAULT_WORKFLOW_MODE,
      tasks: state.tasks,
      briefHash,
    })
  );
}

/**
 * The recovery journal is the durable audit source.  State carries only the
 * current journal head and the projection outbox, so a crash can be repaired
 * from either file without asking a provider to repeat work.
 */
const MAX_RECOVERY_OUTBOX = 256;

export type RecoveryFaultPoint =
  | 'before-evidence'
  | 'after-evidence'
  | 'before-state-cas'
  | 'after-state-commit'
  | 'before-delivery'
  | 'after-delivery'
  | 'before-acknowledgement'
  | 'after-acknowledgement';

export type RecoveryStateCommitInput = Readonly<{
  ref: SessionRef;
  expected: WorkflowState;
  next: WorkflowState;
}>;

export type RecoveryStateCommitResult =
  | Readonly<{ kind: 'committed'; state: WorkflowState; revision: ConfigRevision }>
  | Readonly<{ kind: 'conflict'; observedRevision: ConfigRevision | null }>
  | Readonly<{
      kind: 'durability-uncertain';
      state: WorkflowState;
      revision: ConfigRevision;
    }>;

export type RecoveryStateCommitter = (input: RecoveryStateCommitInput) => RecoveryStateCommitResult;

export type RecoveryOutboxDelivery = (
  input: Readonly<{
    ref: SessionRef;
    eventId: string;
    payloadRef: RecoveryEvidenceRef;
    payload: unknown;
    record: RecoveryEvidenceRecord;
  }>,
) => void;

export type RecoveryTransitionInput = Readonly<{
  ref: SessionRef;
  state: WorkflowState;
  nextState: WorkflowState;
  epochId: string;
  kind: RecoveryEvidenceKind;
  operationId?: string | undefined;
  eventId?: string | undefined;
  /** A bounded event or summary. Raw provider payloads must never be supplied. */
  payload: unknown;
  refs?: readonly string[] | undefined;
  after?: RecoveryCheckpoint | null | undefined;
  event?: unknown | undefined;
  commitState?: RecoveryStateCommitter | undefined;
  deliver?: RecoveryOutboxDelivery | undefined;
  bus?: EventBus | undefined;
  onFault?: ((point: RecoveryFaultPoint) => void) | undefined;
}>;

export type RecoveryTransitionResult = Readonly<{
  kind: RecoveryStateCommitResult['kind'];
  state: WorkflowState | null;
  record: RecoveryEvidenceRecord;
  outbox: RecoveryOutboxEntry;
  delivered: boolean;
  acknowledged: boolean;
}>;

export type RecoveryOutboxAckResult = Readonly<{
  kind: RecoveryStateCommitResult['kind'] | 'missing' | 'already-acknowledged';
  state: WorkflowState;
  acknowledged: boolean;
}>;

export type RecoveryOutboxDrainInput = Readonly<{
  ref: SessionRef;
  deliver?: RecoveryOutboxDelivery | undefined;
  bus?: EventBus | undefined;
  commitState?: RecoveryStateCommitter | undefined;
  onFault?: ((point: RecoveryFaultPoint) => void) | undefined;
}>;

export type RecoveryOutboxDrainResult = Readonly<{
  state: WorkflowState;
  deliveredEventIds: readonly string[];
  acknowledgedEventIds: readonly string[];
  remainingEventIds: readonly string[];
}>;

export type ClosePersistedRecoveryEpochInput = Readonly<{
  ref: SessionRef;
  state: WorkflowState;
  epochId: string;
  disposition: RecoveryEpochManifest['disposition'];
  closedAt: string;
  headHash?: string | undefined;
}>;

export type LateRecoveryEvidenceInput = Readonly<{
  ref: SessionRef;
  epochId: string;
  operationId: string;
  kind: 'late-result' | 'late-usage';
  payload: unknown;
  intentHash?: string | undefined;
}>;

export type ClosedRecoveryReplayInput = Readonly<{
  ref: SessionRef;
  epochId: string;
  operationId: string;
  intentHash?: string | undefined;
}>;

function readAuthoritativeRecoveryState(ref: SessionRef): Readonly<{
  state: WorkflowState;
  revision: ConfigRevision;
}> {
  const head = readWorkflowStateHead(ref);
  if (head === null) throw error('recovery-state-missing', 'recovery state head is missing');
  return { state: head.state, revision: head.revision };
}

export function commitRecoveryState(input: RecoveryStateCommitInput): RecoveryStateCommitResult {
  return commitWorkflowState(input);
}

function stateWithRecoveryOutbox(
  state: WorkflowState,
  record: RecoveryEvidenceRecord,
): Readonly<{ state: WorkflowState; outbox: RecoveryOutboxEntry; added: boolean }> {
  const recovery = state.briefRecovery;
  if (recovery === undefined || recovery === null) {
    throw error('recovery-state-missing', 'recovery evidence requires a Brief recovery state');
  }
  const existing = recovery.outbox.find((entry) => entry.eventId === record.eventId);
  if (existing !== undefined) {
    if (existing.payloadRef !== record.payloadRef) {
      throw error(
        'recovery-outbox-event-conflict',
        'recovery outbox event ID is already bound to another payload',
      );
    }
    return { state, outbox: existing, added: false };
  }
  if (recovery.outbox.length >= MAX_RECOVERY_OUTBOX) {
    throw error('recovery-outbox-limit', 'recovery outbox exceeds the bounded size');
  }
  const outbox: RecoveryOutboxEntry = {
    eventId: record.eventId,
    payloadRef: record.payloadRef,
    acknowledged: false,
  };
  const nextRecovery: BriefRecoveryV1 = {
    ...recovery,
    recoveryRevision: recovery.recoveryRevision + 1,
    evidenceHead: record.recordHash,
    outbox: [...recovery.outbox, outbox],
  };
  const nextState: WorkflowState = { ...state, briefRecovery: nextRecovery };
  return { state: nextState, outbox, added: true };
}

function eventIdFromInput(input: RecoveryTransitionInput): string | undefined {
  if (input.eventId !== undefined) return input.eventId;
  const event = input.event;
  if (typeof event !== 'object' || event === null || !('eventId' in event)) return undefined;
  const eventId = event.eventId;
  return typeof eventId === 'string' ? eventId : undefined;
}

function deliverRecoveryOutboxEntry(
  input: Readonly<{
    ref: SessionRef;
    entry: RecoveryOutboxEntry;
    record: RecoveryEvidenceRecord;
    payloadRef: RecoveryEvidenceRef;
    payload: unknown;
    deliver: RecoveryOutboxDelivery | undefined;
    bus: EventBus | undefined;
  }>,
): boolean {
  if (input.deliver !== undefined) {
    input.deliver({
      ref: input.ref,
      eventId: input.entry.eventId,
      payloadRef: input.payloadRef,
      payload: input.payload,
      record: input.record,
    });
    return true;
  }
  if (input.bus === undefined) return false;
  const event = parseEngineEvent(input.payload);
  if (event === null) {
    throw error(
      'recovery-outbox-payload-invalid',
      'recovery outbox payload is not a canonical engine event',
    );
  }
  input.bus.publish(event);
  return true;
}

/** Mark one committed outbox item delivered, using a later fenced CAS. */
export function acknowledgeRecoveryOutbox(
  input: Readonly<{
    ref: SessionRef;
    eventId: string;
    commitState?: RecoveryStateCommitter | undefined;
  }>,
): RecoveryOutboxAckResult {
  const current = readAuthoritativeRecoveryState(input.ref).state;
  const recovery = current.briefRecovery;
  if (recovery === undefined || recovery === null) {
    return { kind: 'missing', state: current, acknowledged: false };
  }
  const entry = recovery.outbox.find((candidate) => candidate.eventId === input.eventId);
  if (entry === undefined) return { kind: 'missing', state: current, acknowledged: false };
  if (entry.acknowledged) {
    return { kind: 'already-acknowledged', state: current, acknowledged: true };
  }
  const nextRecovery: BriefRecoveryV1 = {
    ...recovery,
    outbox: recovery.outbox.map((candidate) =>
      candidate.eventId === input.eventId ? { ...candidate, acknowledged: true } : candidate,
    ),
  };
  const next: WorkflowState = { ...current, briefRecovery: nextRecovery };
  const committed = (input.commitState ?? commitRecoveryState)({
    ref: input.ref,
    expected: current,
    next,
  });
  if (committed.kind === 'conflict') {
    return { kind: 'conflict', state: current, acknowledged: false };
  }
  return {
    kind: committed.kind,
    state: committed.state,
    acknowledged: committed.kind === 'committed',
  };
}

/**
 * Commit evidence before state, then publish and acknowledge only after the
 * state CAS. If delivery or acknowledgement is interrupted, the durable
 * pending item is left for `drainRecoveryOutbox` after restart.
 */
export function persistRecoveryTransition(
  input: RecoveryTransitionInput,
): RecoveryTransitionResult {
  input.onFault?.('before-evidence');
  const evidence = transactRecoveryEvidence(
    input.ref,
    {
      epochId: input.epochId,
      kind: input.kind,
      operationId: input.operationId,
      eventId: eventIdFromInput(input),
      payload: input.payload,
      refs: input.refs,
      after: input.after ?? null,
    },
    ({ record }) => {
      input.onFault?.('after-evidence');
      const projected = stateWithRecoveryOutbox(input.nextState, record);
      input.onFault?.('before-state-cas');
      const committed = (input.commitState ?? commitRecoveryState)({
        ref: input.ref,
        expected: input.state,
        next: projected.state,
      });
      return {
        commit: committed.kind !== 'conflict',
        result: { committed, projected },
      };
    },
  );
  const { committed, projected } = evidence.result;
  const outbox = projected.outbox;
  if (committed.kind === 'conflict' || committed.kind === 'durability-uncertain') {
    return {
      kind: committed.kind,
      state: committed.kind === 'durability-uncertain' ? committed.state : null,
      record: evidence.record,
      outbox,
      delivered: false,
      acknowledged: false,
    };
  }

  input.onFault?.('after-state-commit');
  input.onFault?.('before-delivery');
  const payload = readRecoveryArtifact(input.ref, evidence.ref);
  const delivered = deliverRecoveryOutboxEntry({
    ref: input.ref,
    entry: outbox,
    record: evidence.record,
    payloadRef: evidence.ref,
    payload,
    deliver: input.deliver,
    bus: input.bus,
  });
  if (!delivered) {
    return {
      kind: 'committed',
      state: committed.state,
      record: evidence.record,
      outbox,
      delivered: false,
      acknowledged: false,
    };
  }
  input.onFault?.('after-delivery');
  input.onFault?.('before-acknowledgement');
  const acknowledged = acknowledgeRecoveryOutbox({
    ref: input.ref,
    eventId: outbox.eventId,
    commitState: input.commitState,
  });
  input.onFault?.('after-acknowledgement');
  return {
    kind: acknowledged.kind === 'durability-uncertain' ? 'durability-uncertain' : 'committed',
    state: acknowledged.state,
    record: evidence.record,
    outbox: {
      ...outbox,
      acknowledged: acknowledged.acknowledged,
    },
    delivered: true,
    acknowledged: acknowledged.acknowledged,
  };
}

/**
 * The sole fenced owner commit. Refusal, acceptance, generation publication,
 * and permit issuance all flow through this one seam: bounded evidence first,
 * then the outbox projection, then the fenced state CAS, then delivery, then
 * acknowledgement. The canonical owner event is the durable evidence payload,
 * so the outbox delivers exactly the committed event; the evidence checkpoint
 * is derived from the authoritative head, never trusted from the caller.
 */
export type BriefOwnerTransitionOperations = Readonly<{
  ref: SessionRef;
  deliver?: RecoveryOutboxDelivery | undefined;
  bus?: EventBus | undefined;
  onFault?: ((point: RecoveryFaultPoint) => void) | undefined;
}>;

export const OWNER_EVIDENCE_KIND: Record<BriefOwnerEvent['type'], RecoveryEvidenceKind> = {
  brief_recovery_refused: 'rejection',
  brief_recovery_transition: 'outcome',
  brief_recovery_accepted: 'receipt',
  brief_generation_published: 'outcome',
  brief_execution_permit_issued: 'outcome',
};

type OwnerPatchMismatch = Readonly<
  | {
      kind: 'event-generation';
      eventGenerationId: string;
      patchGenerationId: string | null;
    }
  | {
      kind: 'event-permit';
      eventPermitEpochId: string;
      patchPermitPresent: boolean;
    }
>;

function ownerPatchMismatch(
  event: BriefOwnerEvent,
  patch: BriefOwnerStatePatch,
): OwnerPatchMismatch | null {
  if (
    event.type !== 'brief_generation_published' &&
    event.type !== 'brief_execution_permit_issued'
  ) {
    return null;
  }
  if (event.type === 'brief_execution_permit_issued') {
    const permit = patch.permit;
    if (permit !== null && sameExecutionPermit(event.permit, permit)) return null;
    return {
      kind: 'event-permit',
      eventPermitEpochId: event.permit.epochId,
      patchPermitPresent: permit !== null,
    };
  }
  const generation = patch.generation;
  const matches =
    generation !== null &&
    generation.generationId === event.generation.generationId &&
    generation.manifestDigest === event.generation.manifestDigest &&
    generation.tasksDigest === event.generation.tasksDigest &&
    generation.qualityDigest === event.generation.qualityDigest;
  if (matches) return null;
  return {
    kind: 'event-generation',
    eventGenerationId: event.generation.generationId,
    patchGenerationId: generation?.generationId ?? null,
  };
}

function recoveryViewOf(state: WorkflowState): BriefRecoveryStateView {
  return {
    stateVersion: state.stateVersion,
    stateRevision: workflowStateRevision(state),
    stateFence: state.stateFence ?? { token: 0, ownerId: 'initial' },
    phase: state.phase,
    briefRecovery: state.briefRecovery ?? null,
  };
}

function recoveryCheckpointAfter(
  recovery: BriefRecoveryV1,
  state: WorkflowState,
): RecoveryCheckpoint | null {
  if (!('activeOperationId' in recovery)) return null;
  return {
    stateRevision: workflowStateRevision(state),
    recoveryRevision: recovery.recoveryRevision,
    status: recovery.status,
    activeOperationId: recovery.activeOperationId,
    evidenceHead: recovery.evidenceHead,
  };
}

function applyOwnerOutbox(
  recovery: BriefRecoveryV1 | null,
  record: RecoveryEvidenceRecord,
  payloadRef: string,
): BriefRecoveryV1 {
  if (recovery === null) {
    throw error('recovery-state-missing', 'recovery evidence requires a Brief recovery state');
  }
  const existing = recovery.outbox.find((entry) => entry.eventId === record.eventId);
  if (existing !== undefined) {
    if (existing.payloadRef !== payloadRef) {
      throw error(
        'recovery-outbox-event-conflict',
        'recovery outbox event ID is already bound to another payload',
      );
    }
    return { ...recovery, evidenceHead: record.recordHash };
  }
  if (recovery.outbox.length >= MAX_RECOVERY_OUTBOX) {
    throw error('recovery-outbox-limit', 'recovery outbox exceeds the bounded size');
  }
  return {
    ...recovery,
    ...('activeOperationId' in recovery ? { recoveryRevision: recovery.recoveryRevision + 1 } : {}),
    evidenceHead: record.recordHash,
    outbox: [...recovery.outbox, { eventId: record.eventId, payloadRef, acknowledged: false }],
  };
}

type BriefOwnerTransitionOutcome = Readonly<
  | { kind: 'committed'; committed: WorkflowStateCommitResult; patch: BriefOwnerStatePatch }
  | { kind: 'rejected'; mismatch: OwnerPatchMismatch }
>;

function briefOwnerCommittedResult(
  revision: ConfigRevision,
  patch: BriefOwnerStatePatch,
  view: BriefRecoveryStateView,
): BriefOwnerCommitResult {
  return BriefOwnerCommitResultSchema.parse({
    kind: 'committed',
    stateRevision: revision,
    authorityRevision: patch.authorityRevision,
    recovery: view,
    generation: patch.generation,
    permit: patch.permit,
  });
}

export function persistBriefOwnerTransition(
  input: BriefOwnerCommitInput & BriefOwnerTransitionOperations,
): BriefOwnerCommitResult {
  const { ref, expected } = input;
  const conflict = (): BriefOwnerCommitResult =>
    BriefOwnerCommitResultSchema.parse({
      kind: 'conflict',
      stateRevision: null,
      authorityRevision: null,
      recovery: null,
      generation: null,
      permit: null,
    });
  const head = readWorkflowStateHead(ref);
  if (head === null) return conflict();
  const recovery = head.state.briefRecovery;
  if (recovery === null || recovery === undefined) return conflict();
  if (expected.epochId !== recovery.epochId) return conflict();
  if (input.evidence.epochId !== expected.epochId) return conflict();
  if (!revisionsMatch(expected.stateRevision, head.revision)) return conflict();
  if ((head.state.authorityRevision ?? 0) !== expected.authorityRevision) return conflict();
  if (String(head.state.stateFence?.token ?? 0) !== expected.fence) return conflict();
  if (expected.evidenceHead !== recovery.evidenceHead) return conflict();

  const currentView: BriefRecoveryStateView = recoveryViewOf(head.state);
  input.onFault?.('before-evidence');
  const evidence = transactRecoveryEvidence<BriefOwnerTransitionOutcome>(
    ref,
    {
      epochId: input.evidence.epochId,
      kind: OWNER_EVIDENCE_KIND[input.event.type],
      operationId: input.operationId,
      eventId: input.event.eventId,
      payload: input.event,
      refs: input.evidence.refs,
      after: recoveryCheckpointAfter(recovery, head.state),
    },
    ({ ref: evidenceRef, record }) => {
      input.onFault?.('after-evidence');
      const patch = BriefOwnerStatePatchSchema.parse(
        input.projectNext({ current: currentView, evidenceRef, eventId: record.eventId }),
      );
      if (patch.authorityRevision !== expected.authorityRevision + 1) {
        throw error(
          'brief-owner-authority-advance',
          'the owner patch must advance the authority revision by exactly one',
          { expected: expected.authorityRevision, projected: patch.authorityRevision },
        );
      }
      const mismatch = ownerPatchMismatch(input.event, patch);
      if (mismatch !== null) {
        return { commit: false, result: { kind: 'rejected' as const, mismatch } };
      }
      const projectedRecovery = applyOwnerOutbox(
        patch.recovery.briefRecovery,
        record,
        evidenceRef.path,
      );
      input.onFault?.('before-state-cas');
      const next: WorkflowState = {
        ...head.state,
        phase: PhaseSchema.parse(patch.recovery.phase),
        briefRecovery: projectedRecovery,
        authorityRevision: patch.authorityRevision,
        generation: patch.generation,
        permit: patch.permit,
      };
      const committed = commitWorkflowState({ ref, expected: head.state, next });
      return {
        commit: committed.kind !== 'conflict',
        result: { kind: 'committed' as const, committed, patch },
      };
    },
  );
  if (evidence.result.kind === 'rejected') {
    throw error(
      'brief-owner-event-patch-mismatch',
      'the owner patch must identify the generation and permit the event carries',
      evidence.result.mismatch,
    );
  }
  const { committed, patch } = evidence.result;
  if (committed.kind === 'conflict') return conflict();
  const committedView = recoveryViewOf(committed.state);
  if (committed.kind === 'durability-uncertain') {
    return BriefOwnerCommitResultSchema.parse({
      kind: 'durability-uncertain',
      stateRevision: committed.revision,
      authorityRevision: patch.authorityRevision,
      recovery: committedView,
      generation: patch.generation,
      permit: patch.permit,
    });
  }
  input.onFault?.('after-state-commit');
  input.onFault?.('before-delivery');
  const payload = readRecoveryArtifact(ref, evidence.ref);
  const delivered = deliverRecoveryOutboxEntry({
    ref,
    entry: {
      eventId: evidence.record.eventId,
      payloadRef: evidence.ref.path,
      acknowledged: false,
    },
    record: evidence.record,
    payloadRef: evidence.ref,
    payload,
    deliver: input.deliver,
    bus: input.bus,
  });
  if (!delivered) {
    return briefOwnerCommittedResult(committed.revision, patch, committedView);
  }
  input.onFault?.('after-delivery');
  input.onFault?.('before-acknowledgement');
  const acknowledged = acknowledgeRecoveryOutbox({
    ref,
    eventId: evidence.record.eventId,
  });
  input.onFault?.('after-acknowledgement');
  if (acknowledged.kind === 'durability-uncertain') {
    return BriefOwnerCommitResultSchema.parse({
      kind: 'durability-uncertain',
      stateRevision: committed.revision,
      authorityRevision: patch.authorityRevision,
      recovery: committedView,
      generation: patch.generation,
      permit: patch.permit,
    });
  }
  const finalHead = readWorkflowStateHead(ref);
  if (finalHead === null) {
    return briefOwnerCommittedResult(committed.revision, patch, committedView);
  }
  return briefOwnerCommittedResult(finalHead.revision, patch, recoveryViewOf(finalHead.state));
}

/** Drain committed-but-unacknowledged projections without invoking providers. */
export function drainRecoveryOutbox(input: RecoveryOutboxDrainInput): RecoveryOutboxDrainResult {
  return withRecoveryJournalLock(input.ref, (journal) => {
    const deliveredEventIds: string[] = [];
    const acknowledgedEventIds: string[] = [];
    let state = readAuthoritativeRecoveryState(input.ref).state;

    while (true) {
      const recovery = state.briefRecovery;
      if (recovery === undefined || recovery === null) break;
      const pending = recovery.outbox.find((entry) => !entry.acknowledged);
      if (pending === undefined) break;
      const record = journal.records.find((candidate) => candidate.eventId === pending.eventId);
      if (record === undefined) {
        throw error('recovery-outbox-record-missing', 'recovery outbox item has no audit record');
      }
      const payloadRef = recoveryReferenceFromPath(input.ref, pending.payloadRef);
      const payload = readRecoveryArtifact(input.ref, payloadRef);

      input.onFault?.('before-delivery');
      const delivered = deliverRecoveryOutboxEntry({
        ref: input.ref,
        entry: pending,
        record,
        payloadRef,
        payload,
        deliver: input.deliver,
        bus: input.bus,
      });
      if (!delivered) break;
      deliveredEventIds.push(pending.eventId);
      input.onFault?.('after-delivery');
      input.onFault?.('before-acknowledgement');
      const acknowledged = acknowledgeRecoveryOutbox({
        ref: input.ref,
        eventId: pending.eventId,
        commitState: input.commitState,
      });
      input.onFault?.('after-acknowledgement');
      if (!acknowledged.acknowledged) break;
      acknowledgedEventIds.push(pending.eventId);
      state = acknowledged.state;
    }

    const remaining =
      state.briefRecovery?.outbox
        .filter((entry) => !entry.acknowledged)
        .map((entry) => entry.eventId) ?? [];
    return { state, deliveredEventIds, acknowledgedEventIds, remainingEventIds: remaining };
  });
}

export function closePersistedRecoveryEpoch(
  input: ClosePersistedRecoveryEpochInput,
): RecoveryEpochManifest {
  const recovery = input.state.briefRecovery;
  if (recovery === undefined || recovery === null) {
    throw error('recovery-state-missing', 'cannot close an epoch without a recovery state');
  }
  return closeRecoveryEpoch(input.ref, {
    epochId: input.epochId,
    disposition: input.disposition,
    closedAt: input.closedAt,
    headHash: input.headHash ?? recovery.evidenceHead,
    outbox: recovery.outbox,
  });
}

export function writeLateRecoveryEvidence(input: LateRecoveryEvidenceInput): RecoverySidecarResult {
  return writeRecoverySidecar(input.ref, {
    epochId: input.epochId,
    operationId: input.operationId,
    kind: input.kind,
    payload: input.payload,
    intentHash: input.intentHash,
  });
}

export function replayClosedRecoveryEvidence(
  input: ClosedRecoveryReplayInput,
): RecoveryReplayResult {
  return replayClosedRecovery(input.ref, {
    epochId: input.epochId,
    operationId: input.operationId,
    intentHash: input.intentHash,
  });
}

export function persistTaskEvidence(opts: {
  wctx: WorkflowContext;
  state: WorkflowState;
  task: Task;
  recordKind: 'local' | 'retry' | 'skipped';
  details: {
    status: TaskStatus;
    method?: TaskCompletionMethod | undefined;
    retries?: number | undefined;
    durationMs?: number | undefined;
    initialValidation?: ValidationResult[] | undefined;
    initialChangedFiles?: string[] | undefined;
    initialExemptStages?: readonly EvidenceValidationEntry['stage'][] | undefined;
    validation?: ValidationResult[] | undefined;
    escalated?: boolean | undefined;
    reason?: string | undefined;
    changedFiles?: string[] | undefined;
    exemptStages?: readonly EvidenceValidationEntry['stage'][] | undefined;
  };
}): void {
  const { wctx, state, task, recordKind, details } = opts;
  try {
    const briefHash = hashTaskBrief(state.tasks);
    mutateEvidenceLedger(wctx, (existing) => {
      const ledger =
        existing ?? getOrCreateLedger({ ref: wctx, state, mode: wctx.config.workflow.mode });
      if (recordKind === 'local') {
        return recordLocalTaskEvidence({
          ledger,
          task,
          status: details.status,
          method: details.method,
          retries: details.retries,
          durationMs: details.durationMs,
          validation: details.validation ?? [],
          changedFiles: details.changedFiles,
          briefHash,
          validationRetryState: details.status === 'failed' ? 'failed' : undefined,
          exemptStages: details.exemptStages,
        });
      }
      if (recordKind === 'retry') {
        let updated = ledger;
        if (details.initialValidation && details.initialValidation.length > 0) {
          updated = recordRetryOrEscalationEvidence({
            ledger: updated,
            task,
            status: details.status,
            method: details.method,
            retries: details.retries,
            durationMs: details.durationMs,
            validation: details.initialValidation,
            escalated: details.escalated ?? false,
            changedFiles: details.initialChangedFiles,
            briefHash,
            validationRetryState: 'initial-failure',
            exemptStages: details.initialExemptStages,
          });
        }
        return recordRetryOrEscalationEvidence({
          ledger: updated,
          task,
          status: details.status,
          method: details.method,
          retries: details.retries,
          durationMs: details.durationMs,
          validation: details.validation,
          escalated: details.escalated ?? false,
          changedFiles: details.changedFiles,
          briefHash,
          validationRetryState: details.escalated
            ? 'escalated'
            : details.status === 'failed'
              ? 'failed'
              : undefined,
          exemptStages: details.exemptStages,
        });
      }
      return recordSkippedTaskEvidence({
        ledger,
        task,
        reason: details.reason ?? 'skipped',
        briefHash,
      });
    });
  } catch (err) {
    publishWarningFromError(
      { bus: wctx.bus, phase: state.phase },
      'failed to persist evidence ledger',
      err,
    );
  }
}

export function persistRejectionEvidence(opts: {
  wctx: WorkflowContext;
  state: WorkflowState;
  reason: string;
  actionClass: ActionClass;
  tier: 'sticky' | 'confirm';
  actionDescription: string;
  taskId?: TaskId | undefined;
}): void {
  const { wctx, state, reason, actionClass, tier, actionDescription, taskId } = opts;
  try {
    mutateEvidenceLedger(wctx, (existing) => {
      const ledger =
        existing ?? getOrCreateLedger({ ref: wctx, state, mode: wctx.config.workflow.mode });
      return recordRejectionEvidence({
        ledger,
        tier,
        actionClass,
        actionDescription,
        ...(taskId !== undefined && { taskId }),
        reason,
      });
    });
  } catch {
    // non-fatal: rejection evidence loss is acceptable vs crashing
  }
}

export function persistApprovalEvidence(opts: {
  wctx: WorkflowContext;
  state: WorkflowState;
  decision: GateDecision;
  taskId?: TaskId | undefined;
}): void {
  const { wctx, state, decision, taskId } = opts;
  const confirmApprovals = decision.confirmApprovals;
  if (!confirmApprovals || confirmApprovals.length === 0) return;
  try {
    mutateEvidenceLedger(wctx, (existing) => {
      let ledger =
        existing ?? getOrCreateLedger({ ref: wctx, state, mode: wctx.config.workflow.mode });
      for (const approval of confirmApprovals) {
        ledger = recordApprovalEvidence({
          ledger,
          tier: approval.tier,
          actionClass: approval.actionClass,
          actionDescription: approval.actionDescription,
          ...(taskId !== undefined && { taskId }),
          reason: approval.reason,
        });
      }
      return ledger;
    });
  } catch (err) {
    publishWarningFromError(
      { bus: wctx.bus, phase: state.phase },
      'failed to persist approval evidence',
      err,
    );
  }
}
