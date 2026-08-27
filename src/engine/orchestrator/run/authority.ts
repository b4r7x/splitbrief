import { WorkflowStateSchema, type WorkflowState } from '../../../core/schemas/workflow.js';
import { createInitialState } from '../../../core/state/machine.js';
import {
  assertCandidateAuthority,
  promoteCandidateAuthority,
  refreshStateAuthority,
} from '../../../core/state/authority.js';
import { workflowStateDigest } from '../../../core/state/persistence.js';
import type { StateAuthorityCandidate, StateAuthorityReceipt } from '../../../core/state/types.js';
import type { SessionRef } from '../../../core/types/session-ref.js';
import { error } from '../../../utils/error.js';
import { commitWorkflowState, type StateMutationOptions } from '../state-ops.js';
import type { WorkflowContext } from '../types.js';

export type WorkflowAuthorityHolder = { current: StateAuthorityReceipt };

type WorkflowAuthorityCarrier = Pick<WorkflowContext, 'stateAuthority'>;

export function attachWorkflowAuthority<T extends WorkflowAuthorityCarrier>(
  value: T,
  authority: StateAuthorityReceipt,
): T {
  value.stateAuthority = authority;
  return value;
}

export function workflowAuthority(
  value: WorkflowAuthorityCarrier,
): StateAuthorityReceipt | undefined {
  return value.stateAuthority;
}

export function deriveWorkflowAuthority(
  authority: StateAuthorityReceipt,
  state: WorkflowState,
): StateAuthorityReceipt {
  if (
    state.stateFence?.ownerId !== authority.ownerId ||
    state.stateFence.token !== authority.fence
  ) {
    throw error('state-authority-invalid', 'Workflow state fence does not match its owner.');
  }
  return {
    ...authority,
    stateRevision: state.stateRevision ?? 0,
    stateDigest: workflowStateDigest(state),
  };
}

export function refreshWorkflowAuthority(
  ref: SessionRef,
  authority: StateAuthorityReceipt,
  state: WorkflowState,
): StateAuthorityReceipt {
  const next = deriveWorkflowAuthority(authority, state);
  if (
    next.stateRevision === authority.stateRevision &&
    next.stateDigest === authority.stateDigest
  ) {
    return authority;
  }
  return refreshStateAuthority(ref, authority, {
    stateRevision: next.stateRevision,
    stateDigest: next.stateDigest,
  });
}

export function workflowMutationOptions(
  state: WorkflowState,
  authority: StateAuthorityReceipt | undefined,
  extra: Pick<StateMutationOptions, 'maxRetries' | 'conflictRetries'> = {},
): StateMutationOptions {
  return {
    expectedRevision: state.stateRevision,
    ...(authority !== undefined && { authority }),
    ...extra,
  };
}

export function consumeNewWorkflowCandidate(
  ref: SessionRef,
  candidate: StateAuthorityCandidate,
  feature: string,
): StateAuthorityReceipt {
  if (candidate.fence !== 0 || candidate.stateRevision !== 0) {
    throw error('state-authority-invalid', 'A new workflow candidate must start at fence zero.');
  }
  assertCandidateAuthority(ref, candidate);
  const state = WorkflowStateSchema.parse({
    ...createInitialState(feature),
    stateRevision: 1,
    stateFence: { token: 1, ownerId: candidate.ownerId },
  });
  const stateWrite = commitWorkflowState({
    ref,
    expected: null,
    next: state,
  });
  if (stateWrite.kind === 'conflict') {
    throw error('state-persistence-conflict', 'Initial workflow state already exists.');
  }
  if (stateWrite.kind === 'durability-uncertain') {
    throw error(
      'state-persistence-durability-uncertain',
      'Initial workflow state durability is uncertain.',
    );
  }
  return promoteCandidateAuthority(ref, candidate, {
    fence: 1,
    stateRevision: 1,
    stateDigest: stateWrite.revision.rawSha256,
  });
}
