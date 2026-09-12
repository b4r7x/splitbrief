import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync, type BigIntStats } from 'node:fs';
import { join } from 'node:path';
import type { MachineAction } from '../../core/state/types.js';
import { transition } from '../../core/state/machine.js';
import { loadState } from '../../core/state/persistence.js';
import { serializedState } from '../../core/state/state-file.js';
import type { WorkflowState } from '../../core/schemas/workflow.js';
import { WorkflowStateSchema } from '../../core/schemas/workflow.js';
import type { TokenDelta } from '../../core/schemas/tokens.js';
import type { RecoveryIssue } from '../../core/schemas/recovery/schemas.js';
import { confinedAtomicWriteFileSync, type ConfigRevision } from '../../lib/confined-fs-atomic.js';
import { SECURE_FILE_MODE } from '../../lib/fs.js';
import { STATE_FILE, sessionDir } from '../../core/paths.js';
import { assertSessionDirConfined } from '../../core/sessions/confinement.js';
import { error, type AppError } from '../../utils/error.js';
import type { SessionRef } from '../../core/types/session-ref.js';
import { addUsage, type UsageCategory } from './tokens.js';
import { publishCostUpdate, publishRecoveryPrompted } from './events.js';
import type { WorkflowPersistenceContext } from './types.js';

export const MAX_STATE_CONFLICT_RETRIES = 3;
const DEFAULT_STATE_CONFLICT_RETRIES = 1;

export type StateOperationExpectedRevision = number | ConfigRevision | null;

type StateMutationOptions = Readonly<{
  expectedRevision?: StateOperationExpectedRevision | undefined;
  conflictRetries?: number | undefined;
  maxRetries?: number | undefined;
}>;

export type StateOperationContext = WorkflowPersistenceContext &
  Readonly<{
    expectedRevision?: StateOperationExpectedRevision | undefined;
    conflictRetries?: number | undefined;
  }>;

export type StateOperationConflictData = Readonly<{
  operation: 'transition' | 'queue' | 'usage';
  expectedRevision: number | null;
  observedRevision: number | null;
  attempts: number;
  retryLimit: number;
}>;

export type StateOperationConflictError = AppError<
  'state-conflict' | 'state-conflict-exhausted',
  StateOperationConflictData
>;

export const stateOpsError = {
  conflict: (data: StateOperationConflictData): StateOperationConflictError =>
    error('state-conflict', 'Workflow state changed before this mutation committed.', data),
  conflictExhausted: (data: StateOperationConflictData): StateOperationConflictError =>
    error(
      'state-conflict-exhausted',
      'Workflow state kept changing while this mutation was being retried.',
      data,
    ),
  invalidHead: (message: string, cause?: unknown) =>
    error('state-head-invalid', message, undefined, cause),
  durabilityUncertain: (cause?: unknown) =>
    error(
      'state-durability-uncertain',
      'Workflow state replacement completed without a durable revision proof.',
      undefined,
      cause,
    ),
} as const;

type StateHead = Readonly<{
  state: WorkflowState;
  revision: ConfigRevision;
  digest: string;
}>;

type ExpectedIdentity = Readonly<{
  stateRevision: number | null;
  rawRevision: ConfigRevision | null;
  missing: boolean;
}>;

type MutationInput = Readonly<{
  ref: SessionRef;
  state: WorkflowState;
  operation: StateOperationConflictData['operation'];
  options: StateMutationOptions | undefined;
  rederivable: boolean;
  mergeQueue: boolean;
  derive: (state: WorkflowState) => WorkflowState;
}>;

export function workflowStatePath(ref: SessionRef): string {
  assertSessionDirConfined(ref.projectDir, ref.sessionId);
  return join(realpathSync(sessionDir(ref.projectDir, ref.sessionId)), STATE_FILE);
}

function digestBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function revisionFromHead(bytes: Buffer, stat: BigIntStats): ConfigRevision {
  return {
    rawSha256: digestBytes(bytes),
    fileIdentity: {
      dev: stat.dev,
      ino: stat.ino,
      size: stat.size,
      mtimeNs: stat.mtimeNs,
    },
  };
}

export function revisionsMatch(left: ConfigRevision, right: ConfigRevision): boolean {
  return (
    left.rawSha256 === right.rawSha256 &&
    left.fileIdentity.dev === right.fileIdentity.dev &&
    left.fileIdentity.ino === right.fileIdentity.ino &&
    left.fileIdentity.size === right.fileIdentity.size &&
    left.fileIdentity.mtimeNs === right.fileIdentity.mtimeNs
  );
}

function readStateHead(ref: SessionRef): StateHead | null {
  const path = workflowStatePath(ref);
  if (!existsSync(path)) return null;

  if (loadState(ref) === null) {
    throw stateOpsError.invalidHead('Workflow state is unavailable or failed validation.');
  }

  let bytes: Buffer;
  let stat: BigIntStats;
  try {
    bytes = readFileSync(path);
    const candidate = statSync(path, { bigint: true });
    if (!('mtimeNs' in candidate) || typeof candidate.mtimeNs !== 'bigint') {
      throw stateOpsError.invalidHead('Workflow state revision metadata is unavailable.');
    }
    stat = candidate;
  } catch (cause) {
    throw stateOpsError.invalidHead('Workflow state could not be read safely.', cause);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString('utf8'));
  } catch (cause) {
    throw stateOpsError.invalidHead('Workflow state is not valid JSON.', cause);
  }
  const parsed = WorkflowStateSchema.safeParse(raw);
  if (!parsed.success) {
    throw stateOpsError.invalidHead('Workflow state failed schema validation.');
  }

  return {
    state: parsed.data,
    revision: revisionFromHead(bytes, stat),
    digest: digestBytes(bytes),
  };
}

export type WorkflowStateHead = StateHead;

export function readWorkflowStateHead(ref: SessionRef): WorkflowStateHead | null {
  return readStateHead(ref);
}

function mergeNativeDeliveryState(
  persisted: WorkflowState['messageQueue'][number],
  current: WorkflowState['messageQueue'][number],
): WorkflowState['messageQueue'][number]['nativeDeliveryState'] {
  if (persisted.deliveredViaNative || current.deliveredViaNative) return 'delivered';
  if (persisted.nativeDeliveryState === 'delivered' || current.nativeDeliveryState === 'delivered')
    return 'delivered';
  if (persisted.nativeDeliveryState === 'injecting' || current.nativeDeliveryState === 'injecting')
    return 'injecting';
  return 'pending';
}

function mergeQueues(
  persisted: WorkflowState['messageQueue'],
  current: WorkflowState['messageQueue'],
): WorkflowState['messageQueue'] {
  const byId = new Map(persisted.map((message) => [message.id, message]));
  for (const message of current) {
    const persistedMessage = byId.get(message.id);
    byId.set(
      message.id,
      persistedMessage
        ? {
            ...persistedMessage,
            ...message,
            deliveredViaNative: persistedMessage.deliveredViaNative || message.deliveredViaNative,
            nativeDeliveryState: mergeNativeDeliveryState(persistedMessage, message),
            drainedAt: message.drainedAt ?? persistedMessage.drainedAt,
          }
        : message,
    );
  }
  return [...byId.values()];
}

export function rebaseOnPersistedWorkflowState(
  ref: SessionRef,
  state: WorkflowState,
): WorkflowState {
  const persisted = readStateHead(ref)?.state;
  if (persisted === undefined) return state;
  return { ...persisted, messageQueue: mergeQueues(persisted.messageQueue, state.messageQueue) };
}

function expectedIdentity(expected: StateOperationExpectedRevision | undefined): ExpectedIdentity {
  if (expected === undefined) {
    return {
      stateRevision: null,
      rawRevision: null,
      missing: false,
    };
  }
  if (expected === null) {
    return { stateRevision: null, rawRevision: null, missing: true };
  }
  if (typeof expected === 'number') {
    return { stateRevision: expected, rawRevision: null, missing: false };
  }
  return { stateRevision: null, rawRevision: expected, missing: false };
}

function observedRevision(head: StateHead | null): number | null {
  return head?.state.stateRevision ?? null;
}

function currentStateRevision(head: StateHead | null): number {
  return head?.state.stateRevision ?? 0;
}

function conflictData(
  operation: StateOperationConflictData['operation'],
  expected: ExpectedIdentity,
  head: StateHead | null,
  attempts: number,
  retryLimit: number,
): StateOperationConflictData {
  return {
    operation,
    expectedRevision: expected.stateRevision,
    observedRevision: observedRevision(head),
    attempts,
    retryLimit,
  };
}

function expectedConflicts(expected: ExpectedIdentity, head: StateHead | null): boolean {
  if (expected.missing && head !== null) return true;
  if (expected.stateRevision !== null && expected.stateRevision !== currentStateRevision(head)) {
    return true;
  }
  if (
    expected.rawRevision !== null &&
    (head === null || !revisionsMatch(expected.rawRevision, head.revision))
  ) {
    return true;
  }
  return false;
}

function retryLimit(options: StateMutationOptions | undefined, rederivable: boolean): number {
  if (!rederivable) return 0;
  const requested = options?.conflictRetries ?? options?.maxRetries;
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

function queueAction(action: MachineAction): boolean {
  switch (action.type) {
    case 'ENQUEUE_USER_MSG':
    case 'MARK_INJECTING_NATIVE':
    case 'MARK_DELIVERED_NATIVE':
    case 'MARK_NATIVE_DELIVERY_FAILED':
    case 'DRAIN_QUEUE':
    case 'CLEAR_QUEUE':
      return true;
    default:
      return false;
  }
}

function preparedState(base: WorkflowState, next: WorkflowState): WorkflowState {
  return {
    ...next,
    stateRevision: (base.stateRevision ?? 0) + 1,
  };
}

function commitState(
  ref: SessionRef,
  head: StateHead | null,
  state: WorkflowState,
): 'written' | 'conflict' {
  let result: ReturnType<typeof confinedAtomicWriteFileSync>;
  try {
    result = confinedAtomicWriteFileSync(workflowStatePath(ref), serializedState(state), {
      expectedRevision: head?.revision ?? null,
      mode: SECURE_FILE_MODE,
    });
  } catch (cause) {
    throw stateOpsError.durabilityUncertain(cause);
  }
  if (result.kind === 'conflict') return 'conflict';
  if (result.kind === 'durability-uncertain') {
    throw stateOpsError.durabilityUncertain();
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
          stateVersion: 4,
          stateRevision: workflowStateRevision(input.expected) + 1,
        });
  const result = confinedAtomicWriteFileSync(
    workflowStatePath(input.ref),
    serializedState(nextState),
    {
      expectedRevision: current?.revision ?? null,
      mode: SECURE_FILE_MODE,
    },
  );
  if (result.kind === 'conflict') return result;
  if (result.kind === 'durability-uncertain') {
    return { kind: 'durability-uncertain', state: nextState, revision: result.observedRevision };
  }
  return { kind: 'committed', state: nextState, revision: result.revision };
}

function mutateState(input: MutationInput): WorkflowState {
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
      if (retries < retryCount) {
        retries += 1;
        expected = observedRevision(head);
        continue;
      }
      throw retries > 0 ? stateOpsError.conflictExhausted(data) : stateOpsError.conflict(data);
    }

    const base =
      head === null
        ? input.state
        : hasExplicitRevision
          ? input.mergeQueue
            ? {
                ...head.state,
                messageQueue: mergeQueues(head.state.messageQueue, input.state.messageQueue),
              }
            : head.state
          : input.operation === 'usage'
            ? {
                ...head.state,
                messageQueue: mergeQueues(head.state.messageQueue, input.state.messageQueue),
              }
            : {
                // Older engine seams pass the semantic state they are about to
                // mutate, while the persisted head may have advanced through a
                // queue/native-delivery writer. Keep that semantic input, but
                // bind its revision to the head used by the CAS.
                ...input.state,
                stateVersion: head.state.stateVersion,
                stateRevision: head.state.stateRevision ?? 0,
                messageQueue: mergeQueues(head.state.messageQueue, input.state.messageQueue),
              };
    const next = preparedState(base, input.derive(base));
    const committed = commitState(input.ref, head, next);
    if (committed === 'written') {
      return next;
    }

    const latest = readStateHead(input.ref);
    const data = conflictData(input.operation, identity, latest, retries, retryCount);
    if (retries < retryCount) {
      retries += 1;
      expected = observedRevision(latest);
      continue;
    }
    throw retries > 0 ? stateOpsError.conflictExhausted(data) : stateOpsError.conflict(data);
  }
}

export function transitionAndSave(
  ref: SessionRef,
  state: WorkflowState,
  action: MachineAction,
  options?: StateMutationOptions,
): WorkflowState {
  const isQueueMutation = queueAction(action);
  return mutateState({
    ref,
    state,
    operation: isQueueMutation ? 'queue' : 'transition',
    options,
    rederivable: isQueueMutation,
    mergeQueue: isQueueMutation,
    derive: (base) => {
      if (
        action.type === 'ENQUEUE_USER_MSG' &&
        base.messageQueue.some((message) => message.id === action.message.id)
      ) {
        return base;
      }
      return transition(base, action, { maxRetries: options?.maxRetries });
    },
  });
}

export function raisePendingRecovery(
  scope: WorkflowPersistenceContext,
  state: WorkflowState,
  issue: RecoveryIssue,
  setTrackedState?: (s: WorkflowState) => void,
): WorkflowState {
  const next = transitionAndSave(scope, state, { type: 'SET_PENDING_RECOVERY', issue });
  publishRecoveryPrompted(scope.bus, issue);
  setTrackedState?.(next);
  return next;
}

export function addUsageAndSave(
  ctx: StateOperationContext,
  state: WorkflowState,
  category: UsageCategory,
  usage: TokenDelta | null | undefined,
  options?: StateMutationOptions,
): WorkflowState {
  if (!usage) return state;
  const mutationOptions =
    options ??
    (ctx.expectedRevision === undefined && ctx.conflictRetries === undefined
      ? undefined
      : {
          expectedRevision: ctx.expectedRevision,
          conflictRetries: ctx.conflictRetries,
        });
  const next = mutateState({
    ref: ctx,
    state,
    operation: 'usage',
    options: mutationOptions,
    rederivable: true,
    mergeQueue: true,
    derive: (base) => addUsage(base, category, usage),
  });
  publishCostUpdate({ bus: ctx.bus, phase: next.phase }, next.tokenUsage);
  return next;
}
