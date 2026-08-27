import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { BriefRecoveryStateView } from '../../../core/schemas/brief-recovery/document.js';
import type {
  BriefOwnerCommitResult,
  BriefOwnerStatePatch,
} from '../../../core/schemas/brief-owner.js';
import { BriefOwnerCommitResultSchema } from '../../../core/schemas/brief-owner.js';
import { PhaseSchema } from '../../../core/schemas/enums.js';
import { workflowStateFence, workflowStateRevision } from '../state-ops.js';

export function recoveryViewOf(state: WorkflowState): BriefRecoveryStateView {
  return {
    stateVersion: state.stateVersion,
    stateRevision: workflowStateRevision(state),
    stateFence: workflowStateFence(state),
    phase: state.phase,
    briefRecovery: state.briefRecovery ?? null,
  };
}

export function ownerConflictResult(): BriefOwnerCommitResult {
  return BriefOwnerCommitResultSchema.parse({
    kind: 'conflict',
    stateRevision: null,
    authorityRevision: null,
    recovery: null,
    generation: null,
    permit: null,
  });
}

/**
 * The committed next state every owner port projects from its patch: the
 * recovery authority fields, plus the rejected-recovery contract that a
 * rejection leaves no executable Tasks behind.
 */
export function projectOwnerCommittedState(
  base: WorkflowState,
  patch: BriefOwnerStatePatch,
): WorkflowState {
  return {
    ...base,
    phase: PhaseSchema.parse(patch.recovery.phase),
    briefRecovery: patch.recovery.briefRecovery,
    authorityRevision: patch.authorityRevision,
    generation: patch.generation,
    permit: patch.permit,
    ...(patch.recovery.briefRecovery?.status === 'rejected'
      ? { tasks: [], currentTaskIndex: 0, attempt: 0 }
      : {}),
  };
}
