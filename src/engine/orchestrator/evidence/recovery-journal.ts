import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { BriefRecoveryV1 } from '../../../core/schemas/brief-recovery/document.js';
import type {
  RecoveryCheckpoint,
  RecoveryEvidenceKind,
  RecoveryEvidenceRecord,
  RecoveryEpochManifest,
  RecoveryEvidenceRef,
  RecoveryOutboxEntry,
} from '../../../core/evidence/recovery-journal/schema.js';
import {
  readRecoveryArtifact,
  recoveryReferenceFromPath,
} from '../../../core/evidence/recovery-journal/artifacts.js';
import {
  transactRecoveryEvidence,
  withRecoveryJournalLock,
} from '../../../core/evidence/recovery-journal/journal.js';
import { closeRecoveryEpoch } from '../../../core/evidence/recovery-journal/epoch.js';
import {
  replayClosedRecovery,
  writeRecoverySidecar,
  type RecoveryReplayResult,
  type RecoverySidecarResult,
} from '../../../core/evidence/recovery-journal/sidecar.js';
import type { SessionRef } from '../../../core/types/session-ref.js';
import type { ConfigRevision } from '../../../lib/confined-fs-atomic.js';
import { parseEngineEvent } from '../../events/schema.js';
import type { EventBus } from '../../events/types.js';
import { error } from '../../../utils/error.js';
import { commitWorkflowState, readWorkflowStateHead } from '../state-ops.js';

/**
 * The recovery journal is the durable audit source.  State carries only the
 * current journal head and the projection outbox, so a crash can be repaired
 * from either file without asking a provider to repeat work.
 */
export const MAX_RECOVERY_OUTBOX = 256;

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

export function deliverRecoveryOutboxEntry(
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
