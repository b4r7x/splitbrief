import { existsSync, readFileSync, realpathSync, statSync, type BigIntStats } from 'node:fs';
import { join } from 'node:path';
import type { MachineAction } from '../../core/state/types.js';
import { briefCorrections, transition } from '../../core/state/machine.js';
import { lineageIdOf } from '../../core/state/task-insert.js';
import type { TaskId } from '../../core/schemas/task.js';
import type { Attachment } from '../../core/schemas/attachment.js';
import { loadState } from '../../core/state/persistence.js';
import { keepUnsavedFailure } from '../../core/state/resume-hydration.js';
import { LEGACY_STATE_VERSION } from '../../core/state/migration/legacy-state.js';
import { revisionFromBytes, serializedState } from '../../core/state/state-file.js';
import type { WorkflowState } from '../../core/schemas/workflow.js';
import { WorkflowStateSchema, WORKFLOW_STATE_VERSION } from '../../core/schemas/workflow.js';
import type { TokenDelta } from '../../core/schemas/tokens.js';
import type { RecoveryIssue } from '../../core/schemas/recovery/schemas.js';
import { confinedAtomicWriteFileSync, type ConfigRevision } from '../../lib/confined-fs-atomic.js';
import { SECURE_FILE_MODE } from '../../lib/fs.js';
import { STATE_FILE, sessionDir } from '../../core/paths.js';
import { assertSessionDirConfined } from '../../core/sessions/confinement.js';
import { sessionRelativePath } from '../../core/sessions/ownership-marker.js';
import { sessionFileFailure } from '../../core/sessions/errors.js';
import { SOFT_SEP } from '../../core/separators.js';
import { error, matches, type AppError } from '../../utils/error.js';
import { narrowRecord } from '../../utils/type-guards.js';
import { warnError } from '../../lib/warn.js';
import type { SessionRef } from '../../core/types/session-ref.js';
import { resumeStep } from '../../core/sessions/run-status.js';
import type { EventBus } from '../events/types.js';
import { addUsage, type UsageCategory } from './tokens.js';
import { publishCostUpdate, publishRecoveryPrompted } from './events.js';
import type { WorkflowPersistenceContext } from './types.js';
import { imagesFromMessages } from './queue/prompt.js';
import { keptBriefFiles, runCodeDir } from './kept-work.js';

export const MAX_STATE_CONFLICT_RETRIES = 3;
const DEFAULT_STATE_CONFLICT_RETRIES = 1;

export type StateOperationExpectedRevision = number | ConfigRevision | null;

type StateMutationOptions = Readonly<{
  expectedRevision?: StateOperationExpectedRevision | undefined;
  conflictRetries?: number | undefined;
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
  isInvalidHead: matches('state-head-invalid'),
  notSaved: (sessionId: string, cause: unknown) =>
    error(
      'state-not-saved',
      sessionFileFailure(
        'Could not save the run state',
        sessionRelativePath(sessionId, STATE_FILE),
        cause,
      ),
      undefined,
      cause,
    ),
  durabilityUncertain: (sessionId: string) =>
    error(
      'state-durability-uncertain',
      `Saved the run state, but could not confirm it on disk${SOFT_SEP}${sessionRelativePath(sessionId, STATE_FILE)}`,
    ),
  notRead: (sessionId: string, cause: unknown) =>
    error(
      'state-head-invalid',
      sessionFileFailure(
        'Could not read the run state',
        sessionRelativePath(sessionId, STATE_FILE),
        cause,
      ),
      undefined,
      cause,
    ),
  changedOnDisk: (sessionId: string) =>
    error(
      'state-changed-on-disk',
      sessionFileFailure(
        'Could not save the run state',
        sessionRelativePath(sessionId, STATE_FILE),
        'the file changed on disk before SPLITBRIEF could save it',
      ),
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

  const loaded = loadState(ref);
  if (loaded === null) {
    throw stateOpsError.notRead(ref.sessionId, 'it could not be read, or its content is not valid');
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
    throw stateOpsError.notRead(ref.sessionId, cause);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString('utf8'));
  } catch (cause) {
    throw stateOpsError.invalidHead('Workflow state is not valid JSON.', cause);
  }
  const revision = revisionFromBytes(bytes, stat);
  // A v3 file reads as the v4 state `loadState` maps it to; its first write saves it as v4.
  if (narrowRecord(raw)?.stateVersion === LEGACY_STATE_VERSION) {
    return { state: loaded, revision, digest: revision.rawSha256 };
  }
  const parsed = WorkflowStateSchema.safeParse(raw);
  if (!parsed.success) {
    throw stateOpsError.invalidHead('Workflow state failed schema validation.');
  }
  return { state: parsed.data, revision, digest: revision.rawSha256 };
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
  persisted: WorkflowState,
  current: WorkflowState,
): WorkflowState['messageQueue'] {
  // Only a shared revision proves an absent message is unsaved. An older queue
  // can contain messages a later writer cleared or delivered.
  if (persisted.stateRevision !== current.stateRevision) return persisted.messageQueue;
  const byId = new Map(persisted.messageQueue.map((message) => [message.id, message]));
  for (const message of current.messageQueue) {
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
            deliveredTo:
              persistedMessage.deliveredTo === undefined && message.deliveredTo === undefined
                ? undefined
                : { ...persistedMessage.deliveredTo, ...message.deliveredTo },
          }
        : message,
    );
  }
  return [...byId.values()];
}

export function rebaseOnPersistedWorkflowState(
  ref: SessionRef,
  state: WorkflowState,
  options?: Readonly<{ keepUnsaved?: boolean | undefined }>,
): WorkflowState {
  const persisted = readStateHead(ref)?.state;
  if (persisted === undefined) return state;
  // Queue reads keep unsaved workflow fields their caller has not saved yet while the
  // caller and disk share a committed revision. Every other caller treats the persisted
  // head as truth: a rewind, recovery, or usage write that landed behind its back at the
  // same revision must not be erased by the caller's older in-memory copy.
  const current =
    options?.keepUnsaved === true &&
    (state.stateRevision ?? 0) > 0 &&
    state.stateRevision === persisted.stateRevision &&
    state.phase === persisted.phase
      ? state
      : persisted;
  return { ...current, messageQueue: mergeQueues(persisted, state) };
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

function queueAction(action: MachineAction): boolean {
  switch (action.type) {
    case 'ENQUEUE_USER_MSG':
    case 'MARK_INJECTING_NATIVE':
    case 'MARK_DELIVERED_NATIVE':
    case 'MARK_NATIVE_DELIVERY_FAILED':
    case 'MARK_POSSIBLE_DUPLICATE':
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
      return transition(base, action);
    },
  });
}

export function recordBriefCorrection(
  ref: SessionRef,
  state: WorkflowState,
  taskId: TaskId,
  text: string,
  images: readonly Attachment[] = [],
): WorkflowState {
  const current = rebaseOnPersistedWorkflowState(ref, state);
  const task = current.tasks.find((task) => task.id === taskId);
  const key = task === undefined ? taskId : lineageIdOf(task);
  const priorImages = current.lineages?.[key]?.correctionImages ?? [];
  if (
    briefCorrections(current, taskId).includes(text) &&
    images.every((image) => priorImages.some((prior) => prior.id === image.id))
  )
    return current;
  return mutateState({
    ref,
    state: current,
    operation: 'transition',
    options: undefined,
    rederivable: false,
    mergeQueue: false,
    derive: (base) => {
      const corrected = briefCorrections(base, taskId).includes(text)
        ? base
        : transition(base, { type: 'RECORD_CORRECTION', taskId, text });
      if (images.length === 0) return corrected;
      return {
        ...corrected,
        lineages: Object.fromEntries(
          Object.entries(corrected.lineages ?? {}).map(([id, lineage]) => [
            id,
            id === key
              ? {
                  ...lineage,
                  correctionImages: imagesFromMessages([
                    { images: lineage.correctionImages ?? [] },
                    { images },
                  ]),
                }
              : lineage,
          ]),
        ),
      };
    },
  });
}

export function recordResumeUserMessage(
  ref: SessionRef,
  message: Pick<
    NonNullable<WorkflowState['resumeUserMessages']>[number],
    'ts' | 'phase' | 'displayText'
  > & {
    text: string;
    answerIndex?: number;
  },
): void {
  if (message.text === message.displayText) return;
  const head = readStateHead(ref);
  if (head === null) {
    throw stateOpsError.invalidHead('Attached user text requires saved workflow state.');
  }
  const { text, answerIndex, ...identity } = message;
  const saved = answerIndex === undefined ? { ...identity, text } : { ...identity, answerIndex };
  mutateState({
    ref,
    state: head.state,
    operation: 'transition',
    options: { expectedRevision: head.state.stateRevision },
    rederivable: false,
    mergeQueue: false,
    derive: (state) => ({
      ...state,
      resumeUserMessages: [...(state.resumeUserMessages ?? []), saved],
    }),
  });
}

export function pruneResumeUserMessages(
  ref: SessionRef,
  messages: NonNullable<WorkflowState['resumeUserMessages']>,
): void {
  if (messages.length === 0) return;
  const head = readStateHead(ref);
  if (head === null)
    throw stateOpsError.invalidHead('Compacted user text requires saved workflow state.');
  mutateState({
    ref,
    state: head.state,
    operation: 'transition',
    options: { expectedRevision: head.state.stateRevision },
    rederivable: false,
    mergeQueue: false,
    derive: (state) => {
      const removals = messages.map((message) => JSON.stringify(message));
      return {
        ...state,
        resumeUserMessages: (state.resumeUserMessages ?? []).filter((message) => {
          const index = removals.indexOf(JSON.stringify(message));
          if (index === -1) return true;
          removals.splice(index, 1);
          return false;
        }),
      };
    },
  });
}

/**
 * Records why a run stopped, through the same CAS boundary as every other head
 * write. A conflict means a later writer already moved the head on; the failure
 * is reported through the bus either way, so the in-memory state is returned
 * rather than raising over a run that has already ended. A save that fails keeps
 * the failure in this process, so the run reads failed here; the disk cannot say so.
 */
export function recordLastFailure(
  ref: SessionRef,
  state: WorkflowState,
  failure: NonNullable<WorkflowState['lastFailure']>,
): WorkflowState {
  const next = { ...state, lastFailure: failure };
  try {
    const result = commitWorkflowState({ ref, expected: state, next });
    return result.kind === 'conflict' ? state : result.state;
  } catch (err) {
    warnError('Could not record why the run failed', err);
    keepUnsavedFailure(ref, state.stateRevision, failure);
    return next;
  }
}

export function raisePendingRecovery(
  scope: WorkflowPersistenceContext,
  state: WorkflowState,
  issue: RecoveryIssue,
  setTrackedState?: (s: WorkflowState) => void,
): WorkflowState {
  const next = transitionAndSave(scope, state, { type: 'SET_PENDING_RECOVERY', issue });
  publishRecoveryPrompted({ bus: scope.bus, phase: next.phase }, scope.sessionId, issue);
  setTrackedState?.(next);
  return next;
}

/**
 * A stop the operator asked for parks the run at the step it picks up at, and the log holds the stop
 * as a row, not only the state. A run stopped before it had a bus still parks. A gate runs no call,
 * so a stop there cuts nothing. A cut brief records the declared files it had changed, read from
 * the run's code as the stop leaves it. A park already recorded stands: leaving a run parked in
 * place is the same stop, so the state and the row stay the first stop's.
 */
export async function parkStoppedRun(
  scope: SessionRef & { bus?: EventBus | undefined },
  state: WorkflowState,
): Promise<WorkflowState> {
  if (state.interruptedStep !== undefined) return state;
  const step = resumeStep(state);
  const cut = step.kind === 'gate' ? 'boundary' : 'mid-step';
  const kept = await keptBriefFiles(runCodeDir(scope.projectDir, state.workspace), state, step);
  const next = transitionAndSave(scope, state, {
    type: 'INTERRUPT_STEP',
    step,
    source: 'user',
    cut,
    kept,
  });
  scope.bus?.publish({
    type: 'turn_interrupted',
    ts: Date.now(),
    phase: next.phase,
    source: 'user',
    at: cut,
    step,
  });
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
