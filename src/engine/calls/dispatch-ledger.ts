import { z } from 'zod';
import { error } from '../../utils/error.js';
import {
  OperationEnvelopeSchema,
  TASK_BRIEF_COMPILER_POLICY,
  TaskCompilationAttemptIdSchema,
  TaskCompilationOperationIdSchema,
  type TaskCompilationAttemptId,
  type TaskCompilationOperationId,
  type TaskCompilationOperationEnvelope,
} from '../../core/schemas/task-compilation.js';

export type DispatchClaim =
  | Readonly<{
      kind: 'claimed';
      attemptId: TaskCompilationAttemptId;
      dispatchNumber: number;
      remaining: number;
    }>
  | Readonly<{
      kind: 'refused';
      attemptId: string;
      reason: 'dispatch-limit' | 'attempt-already-claimed' | 'invalid-attempt-id';
      dispatchCount: number;
      dispatchLimit: number;
    }>;

const nonnegativeInteger = z.number().int().nonnegative();
const dispatchLimitSchema = nonnegativeInteger.max(TASK_BRIEF_COMPILER_POLICY.maxDispatches);

export const DispatchLedgerSnapshotSchema = z
  .strictObject({
    operationId: TaskCompilationOperationIdSchema,
    dispatchCount: nonnegativeInteger,
    dispatchLimit: dispatchLimitSchema,
    claimedAttemptIds: z.array(TaskCompilationAttemptIdSchema).readonly(),
  })
  .superRefine((value, ctx) => {
    if (value.dispatchCount > value.dispatchLimit) {
      ctx.addIssue({
        code: 'custom',
        path: ['dispatchCount'],
        message: 'dispatch count cannot exceed the dispatch limit',
      });
    }
    if (value.dispatchCount !== value.claimedAttemptIds.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['claimedAttemptIds'],
        message: 'claimed attempts must match the dispatch count',
      });
    }
    if (new Set(value.claimedAttemptIds).size !== value.claimedAttemptIds.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['claimedAttemptIds'],
        message: 'claimed attempt IDs must be unique',
      });
    }
  })
  .readonly();
export type DispatchLedgerSnapshot = z.infer<typeof DispatchLedgerSnapshotSchema>;

type DispatchLedgerState = {
  operationId: TaskCompilationOperationId;
  dispatchCount: number;
  dispatchLimit: number;
  claimedAttemptIds: Set<TaskCompilationAttemptId>;
};

export type TaskDispatchClaimHandle = Readonly<{
  claim: (attemptId: TaskCompilationAttemptId) => DispatchClaim;
  snapshot: () => DispatchLedgerSnapshot;
}>;

export type TaskDispatchClaimPort = Readonly<{
  open: (
    input: Readonly<{
      operationId: TaskCompilationOperationId;
      dispatchLimit: number;
      restore?: DispatchLedgerSnapshot;
    }>,
  ) => TaskDispatchClaimHandle;
}>;

export type TaskDispatchLedgerOptions = Readonly<{
  operation: TaskCompilationOperationEnvelope;
  operationId: TaskCompilationOperationId;
  claimPort: TaskDispatchClaimPort;
  restore?: DispatchLedgerSnapshot;
}>;

export type TaskDispatchLedger = Readonly<{
  claimDispatch: (attemptId: TaskCompilationAttemptId | string) => DispatchClaim;
  snapshot: () => DispatchLedgerSnapshot;
}>;

export function createTaskDispatchClaimPort(): TaskDispatchClaimPort {
  const operations = new Map<TaskCompilationOperationId, DispatchLedgerState>();

  return {
    open: ({ operationId, dispatchLimit, restore }) => {
      const parsedOperationId = TaskCompilationOperationIdSchema.parse(operationId);
      const parsedDispatchLimit = dispatchLimitSchema.parse(dispatchLimit);
      const parsedRestore =
        restore === undefined ? undefined : DispatchLedgerSnapshotSchema.parse(restore);
      const existing = operations.get(parsedOperationId);
      if (existing !== undefined) {
        if (existing.dispatchLimit !== parsedDispatchLimit) {
          throw error('dispatch-ledger-conflict', 'dispatch ledger operation limit changed', {
            operationId: parsedOperationId,
            openDispatchLimit: existing.dispatchLimit,
            requestedDispatchLimit: parsedDispatchLimit,
          });
        }
        if (parsedRestore !== undefined) {
          mergeRestore(existing, parsedRestore);
        }
        return createClaimHandle(existing);
      }

      const state: DispatchLedgerState = {
        operationId: parsedOperationId,
        dispatchCount: parsedRestore?.dispatchCount ?? 0,
        dispatchLimit: parsedDispatchLimit,
        claimedAttemptIds: new Set(parsedRestore?.claimedAttemptIds),
      };
      if (parsedRestore !== undefined) {
        assertRestoreMatchesOperation(parsedRestore, parsedOperationId, parsedDispatchLimit);
      }
      operations.set(parsedOperationId, state);
      return createClaimHandle(state);
    },
  };
}

export function createTaskDispatchLedger({
  operation,
  operationId,
  claimPort,
  restore,
}: TaskDispatchLedgerOptions): TaskDispatchLedger {
  const envelope = OperationEnvelopeSchema.parse(operation);
  const parsedOperationId = TaskCompilationOperationIdSchema.parse(operationId);
  const sharedLedger = claimPort.open({
    operationId: parsedOperationId,
    dispatchLimit: envelope.dispatchLimit,
    ...(restore === undefined ? {} : { restore }),
  });

  const claimDispatch = (attemptId: TaskCompilationAttemptId | string): DispatchClaim => {
    const parsedAttempt = TaskCompilationAttemptIdSchema.safeParse(attemptId);
    if (!parsedAttempt.success) {
      const snapshot = sharedLedger.snapshot();
      return {
        kind: 'refused',
        attemptId,
        reason: 'invalid-attempt-id',
        dispatchCount: snapshot.dispatchCount,
        dispatchLimit: snapshot.dispatchLimit,
      };
    }
    return sharedLedger.claim(parsedAttempt.data);
  };

  return {
    claimDispatch,
    snapshot: sharedLedger.snapshot,
  };
}

function createClaimHandle(state: DispatchLedgerState): TaskDispatchClaimHandle {
  return {
    claim: (attemptId) => {
      if (state.claimedAttemptIds.has(attemptId)) {
        return {
          kind: 'refused',
          attemptId,
          reason: 'attempt-already-claimed',
          dispatchCount: state.dispatchCount,
          dispatchLimit: state.dispatchLimit,
        };
      }
      if (state.dispatchCount >= state.dispatchLimit) {
        return {
          kind: 'refused',
          attemptId,
          reason: 'dispatch-limit',
          dispatchCount: state.dispatchCount,
          dispatchLimit: state.dispatchLimit,
        };
      }

      state.claimedAttemptIds.add(attemptId);
      state.dispatchCount += 1;
      return {
        kind: 'claimed',
        attemptId,
        dispatchNumber: state.dispatchCount,
        remaining: state.dispatchLimit - state.dispatchCount,
      };
    },
    snapshot: () =>
      DispatchLedgerSnapshotSchema.parse({
        operationId: state.operationId,
        dispatchCount: state.dispatchCount,
        dispatchLimit: state.dispatchLimit,
        claimedAttemptIds: [...state.claimedAttemptIds],
      }),
  };
}

function assertRestoreMatchesOperation(
  restore: DispatchLedgerSnapshot,
  operationId: TaskCompilationOperationId,
  dispatchLimit: number,
): void {
  if (restore.operationId !== operationId) {
    throw error(
      'dispatch-ledger-restore-invalid',
      'dispatch ledger restore operation identity changed',
      { operationId, restoredOperationId: restore.operationId },
    );
  }
  if (restore.dispatchLimit !== dispatchLimit) {
    throw error(
      'dispatch-ledger-restore-invalid',
      'dispatch ledger restore operation limit changed',
      { operationId, dispatchLimit, restoredDispatchLimit: restore.dispatchLimit },
    );
  }
}

function mergeRestore(state: DispatchLedgerState, restore: DispatchLedgerSnapshot): void {
  assertRestoreMatchesOperation(restore, state.operationId, state.dispatchLimit);
  const mergedAttemptIds = new Set([...state.claimedAttemptIds, ...restore.claimedAttemptIds]);
  if (mergedAttemptIds.size > state.dispatchLimit) {
    throw error(
      'dispatch-ledger-restore-invalid',
      'dispatch ledger restore exceeds dispatch limit',
      {
        operationId: state.operationId,
        dispatchLimit: state.dispatchLimit,
        mergedDispatchCount: mergedAttemptIds.size,
      },
    );
  }
  state.claimedAttemptIds = mergedAttemptIds;
  state.dispatchCount = mergedAttemptIds.size;
}
