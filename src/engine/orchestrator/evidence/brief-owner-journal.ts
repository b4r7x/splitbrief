import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type {
  BriefRecoveryStateView,
  BriefRecoveryV1,
} from '../../../core/schemas/brief-recovery/document.js';
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
import type {
  RecoveryCheckpoint,
  RecoveryEvidenceKind,
  RecoveryEvidenceRecord,
} from '../../../core/evidence/recovery-journal/schema.js';
import { readRecoveryArtifact } from '../../../core/evidence/recovery-journal/artifacts.js';
import { transactRecoveryEvidence } from '../../../core/evidence/recovery-journal/journal.js';
import { PhaseSchema } from '../../../core/schemas/enums.js';
import type { SessionRef } from '../../../core/types/session-ref.js';
import type { ConfigRevision } from '../../../lib/confined-fs-atomic.js';
import type { EventBus } from '../../events/types.js';
import { error } from '../../../utils/error.js';
import { ownerConflictResult, recoveryViewOf } from '../planning/brief-owner-projection.js';
import {
  commitWorkflowState,
  readWorkflowStateHead,
  revisionsMatch,
  workflowStateRevision,
  type WorkflowStateCommitResult,
} from '../state-ops.js';
import {
  MAX_RECOVERY_OUTBOX,
  acknowledgeRecoveryOutbox,
  deliverRecoveryOutboxEntry,
  type RecoveryFaultPoint,
  type RecoveryOutboxDelivery,
} from './recovery-journal.js';

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
  const head = readWorkflowStateHead(ref);
  if (head === null) return ownerConflictResult();
  const recovery = head.state.briefRecovery;
  if (recovery === null || recovery === undefined) return ownerConflictResult();
  if (expected.epochId !== recovery.epochId) return ownerConflictResult();
  if (input.evidence.epochId !== expected.epochId) return ownerConflictResult();
  if (!revisionsMatch(expected.stateRevision, head.revision)) return ownerConflictResult();
  if ((head.state.authorityRevision ?? 0) !== expected.authorityRevision)
    return ownerConflictResult();
  if (String(head.state.stateFence?.token ?? 0) !== expected.fence) return ownerConflictResult();
  if (expected.evidenceHead !== recovery.evidenceHead) return ownerConflictResult();

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
  if (committed.kind === 'conflict') return ownerConflictResult();
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
