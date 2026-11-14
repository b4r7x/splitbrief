import { existsSync, readFileSync, realpathSync, statSync, type BigIntStats } from 'node:fs';
import { join } from 'node:path';
import { sessionDir, STATE_FILE } from '../../../core/paths.js';
import { WorkflowStateSchema, type WorkflowState } from '../../../core/schemas/workflow/state.js';
import { assertSessionDirConfined } from '../../../core/sessions/confinement.js';
import type { SessionRef } from '../../../core/types/session-ref.js';
import type { ConfigRevision } from '../../../lib/fs/atomic-write/types.js';
import { revisionFromBytes } from '../../../core/state/file.js';
import { LEGACY_STATE_VERSION } from '../../../core/state/migration/legacy-state.js';
import { loadState } from '../../../core/state/persistence.js';
import { narrowRecord } from '../../../utils/type-guards.js';
import { stateOpsError } from './errors.js';

export type StateHead = Readonly<{
  state: WorkflowState;
  revision: ConfigRevision;
  digest: string;
}>;

export function workflowStatePath(ref: SessionRef): string {
  assertSessionDirConfined(ref.projectDir, ref.sessionId);
  return join(realpathSync(sessionDir(ref.projectDir, ref.sessionId)), STATE_FILE);
}

export function readStateHead(ref: SessionRef): StateHead | null {
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

export function mergeQueues(
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
