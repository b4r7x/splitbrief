import {
  WORKFLOW_STATE_VERSION,
  WorkflowStateSchema,
  type WorkflowState,
} from '../../../core/schemas/workflow/state.js';
import { serializedState } from '../../../core/state/file.js';
import type { SessionRef } from '../../../core/types/session-ref.js';
import type { ConfigRevision } from '../../../lib/fs/atomic-write/types.js';
import { confinedAtomicWriteFileSync } from '../../../lib/fs/atomic-write/write-sync.js';
import { SECURE_FILE_MODE } from '../../../lib/fs/secure.js';
import { error } from '../../../utils/error.js';
import { expectedIdentity, expectedConflicts, conflictData, observedRevision } from './conflict.js';
import {
  type StateOperationConflictData,
  type StateMutationOptions,
  DEFAULT_STATE_CONFLICT_RETRIES,
  MAX_STATE_CONFLICT_RETRIES,
  type StateOperationExpectedRevision,
  stateOpsError,
} from './errors.js';
import { mergeQueues, readStateHead, workflowStatePath, type StateHead } from './head.js';

type MutationInput = Readonly<{
  ref: SessionRef;
  state: WorkflowState;
  operation: StateOperationConflictData['operation'];
  options: StateMutationOptions | undefined;
  rederivable: boolean;
  mergeQueue: boolean;
  /** A rederivable write retries a conflict only while the latest head passes this. */
  retryWhile?: ((head: WorkflowState) => boolean) | undefined;
  derive: (state: WorkflowState) => WorkflowState;
}>;

// The run that owns a session in this process follows every head committed for it, so the
// phase it stamps on its events is the phase the run is in, not the one it last tracked.
const committedStateFollowers = new Map<string, (state: WorkflowState) => void>();

/** Hands `follower` every head committed for this session until the returned stop runs. */
export function followCommittedState(
  ref: SessionRef,
  follower: (state: WorkflowState) => void,
): () => void {
  const path = workflowStatePath(ref);
  committedStateFollowers.set(path, follower);
  return () => {
    if (committedStateFollowers.get(path) === follower) committedStateFollowers.delete(path);
  };
}

function retryLimit(options: StateMutationOptions | undefined, rederivable: boolean): number {
  if (!rederivable) return 0;
  const requested = options?.conflictRetries;
  if (options?.expectedRevision !== undefined && requested === undefined) {
    return 0;
  }
  if (requested === undefined) return DEFAULT_STATE_CONFLICT_RETRIES;
  if (!Number.isInteger(requested) || requested < 0) {
    throw error(
      'state-invalid-retry-limit',
      'State conflict retry count must be a non-negative integer.',
    );
  }
  return Math.min(requested, MAX_STATE_CONFLICT_RETRIES);
}

function preparedState(base: WorkflowState, next: WorkflowState): WorkflowState {
  return {
    ...next,
    stateRevision: (base.stateRevision ?? 0) + 1,
  };
}

/** The one write of `state.json`: a write that throws names the file and the cause. */
function writeStateFile(
  ref: SessionRef,
  state: WorkflowState,
  expectedRevision: ConfigRevision | null,
): { path: string; result: ReturnType<typeof confinedAtomicWriteFileSync> } {
  try {
    const path = workflowStatePath(ref);
    const result = confinedAtomicWriteFileSync(path, serializedState(state), {
      expectedRevision,
      mode: SECURE_FILE_MODE,
    });
    return { path, result };
  } catch (cause) {
    throw stateOpsError.notSaved(ref.sessionId, cause);
  }
}

function commitState(
  ref: SessionRef,
  head: StateHead | null,
  state: WorkflowState,
): 'written' | 'conflict' {
  const { path, result } = writeStateFile(ref, state, head?.revision ?? null);
  if (result.kind === 'conflict') return 'conflict';
  // An unconfirmed write is in place on disk, so the run follows it and can record its failure.
  committedStateFollowers.get(path)?.(state);
  if (result.kind === 'durability-uncertain') {
    throw stateOpsError.durabilityUncertain(ref.sessionId);
  }
  return 'written';
}

export type WorkflowStateCommitInput = Readonly<{
  ref: SessionRef;
  expected: WorkflowState | null;
  next: WorkflowState;
}>;

type WorkflowStateCommitResult =
  | Readonly<{ kind: 'committed'; state: WorkflowState; revision: ConfigRevision }>
  | Readonly<{ kind: 'conflict'; observedRevision: ConfigRevision | null }>
  | Readonly<{
      kind: 'durability-uncertain';
      state: WorkflowState;
      revision: ConfigRevision;
    }>;

function workflowStateRevision(state: WorkflowState): number {
  const revision = state.stateRevision;
  return revision === undefined || !Number.isInteger(revision) || revision < 0 ? 0 : revision;
}

/**
 * Commit a complete workflow head. All callers share the state-ops CAS
 * boundary; callers never write the state file directly or infer a revision
 * from an event stream.
 */
export function commitWorkflowState(input: WorkflowStateCommitInput): WorkflowStateCommitResult {
  const current = readStateHead(input.ref);
  if (input.expected === null) {
    if (current !== null) return { kind: 'conflict', observedRevision: current.revision };
  } else {
    if (
      current === null ||
      workflowStateRevision(current.state) !== workflowStateRevision(input.expected)
    ) {
      return { kind: 'conflict', observedRevision: current?.revision ?? null };
    }
  }

  const nextState =
    input.expected === null
      ? WorkflowStateSchema.parse(input.next)
      : WorkflowStateSchema.parse({
          ...input.next,
          stateVersion: WORKFLOW_STATE_VERSION,
          stateRevision: workflowStateRevision(input.expected) + 1,
        });
  const { path, result } = writeStateFile(input.ref, nextState, current?.revision ?? null);
  if (result.kind === 'conflict') return result;
  committedStateFollowers.get(path)?.(nextState);
  if (result.kind === 'durability-uncertain') {
    return { kind: 'durability-uncertain', state: nextState, revision: result.observedRevision };
  }
  return { kind: 'committed', state: nextState, revision: result.revision };
}

export function mutateState(input: MutationInput): WorkflowState {
  const retryCount = retryLimit(input.options, input.rederivable);
  const hasExplicitRevision = input.options?.expectedRevision !== undefined;
  let retries = 0;
  let expected: StateOperationExpectedRevision | undefined = hasExplicitRevision
    ? input.options?.expectedRevision
    : undefined;

  while (true) {
    const head = readStateHead(input.ref);
    const identity = expectedIdentity(expected);
    const conflict = expectedConflicts(identity, head);
    if (conflict) {
      const data = conflictData(input.operation, identity, head, retries, retryCount);
      if (retries < retryCount && retriesOn(input, head)) {
        retries += 1;
        expected = observedRevision(head);
        continue;
      }
      throw retries > 0
        ? stateOpsError.conflictExhausted(input.ref.sessionId, data)
        : stateOpsError.conflict(input.ref.sessionId, data);
    }

    const base =
      head === null
        ? input.state
        : hasExplicitRevision
          ? input.mergeQueue
            ? {
                ...(input.operation === 'queue' &&
                (input.state.stateRevision ?? 0) > 0 &&
                input.state.stateRevision === head.state.stateRevision &&
                input.state.phase === head.state.phase
                  ? input.state
                  : head.state),
                messageQueue: mergeQueues(head.state, input.state),
              }
            : head.state
          : input.operation === 'usage'
            ? {
                ...head.state,
                messageQueue: mergeQueues(head.state, input.state),
              }
            : {
                // Older engine seams pass the semantic state they are about to
                // mutate, while the persisted head may have advanced through a
                // queue/native-delivery writer. Keep that semantic input, but
                // bind its revision to the head used by the CAS.
                ...input.state,
                stateVersion: head.state.stateVersion,
                stateRevision: head.state.stateRevision ?? 0,
                messageQueue: mergeQueues(head.state, input.state),
              };
    const recordedBase =
      head?.state.resumeUserMessages === undefined
        ? base
        : { ...base, resumeUserMessages: head.state.resumeUserMessages };
    const next = preparedState(recordedBase, input.derive(recordedBase));
    const committed = commitState(input.ref, head, next);
    if (committed === 'written') {
      return next;
    }

    const latest = readStateHead(input.ref);
    const data = conflictData(input.operation, identity, latest, retries, retryCount);
    if (retries < retryCount && retriesOn(input, latest)) {
      retries += 1;
      expected = observedRevision(latest);
      continue;
    }
    throw retries > 0
      ? stateOpsError.conflictExhausted(input.ref.sessionId, data)
      : stateOpsError.conflict(input.ref.sessionId, data);
  }
}

function retriesOn(input: MutationInput, head: StateHead | null): boolean {
  return input.retryWhile === undefined || (head !== null && input.retryWhile(head.state));
}
