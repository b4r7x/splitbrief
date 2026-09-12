import type { QueuedMessage, WorkflowState } from '../../../core/schemas/workflow.js';
import { rebaseOnPersistedWorkflowState, transitionAndSave } from '../state-ops.js';
import { isQueuedMessagePendingDelivery } from '../../../core/queue-state.js';
import type { SessionRef } from '../../../core/types/session-ref.js';
import type { QueueStateMutationOptions } from './types.js';

type LiveQueueOwner = 'native' | 'prompt';

const liveOwners = new Map<string, Map<string, LiveQueueOwner>>();

function liveOwnerKey(ref: SessionRef): string {
  return `${ref.projectDir}\u0000${ref.sessionId}`;
}

function ownerFor(ref: SessionRef, id: string): LiveQueueOwner | undefined {
  return liveOwners.get(liveOwnerKey(ref))?.get(id);
}

export function claimQueuedMessage(ref: SessionRef, id: string, owner: LiveQueueOwner): boolean {
  const key = liveOwnerKey(ref);
  const owners = liveOwners.get(key) ?? new Map<string, LiveQueueOwner>();
  if (owners.has(id)) return false;
  owners.set(id, owner);
  liveOwners.set(key, owners);
  return true;
}

export function releaseQueuedMessage(ref: SessionRef, id: string, owner: LiveQueueOwner): void {
  const key = liveOwnerKey(ref);
  const owners = liveOwners.get(key);
  if (!owners || owners.get(id) !== owner) return;
  owners.delete(id);
  if (owners.size === 0) liveOwners.delete(key);
}

export function readQueueForPrompt({
  projectDir,
  sessionId,
  state,
}: Omit<QueueStateMutationOptions, 'bus'>): {
  state: WorkflowState;
  messages: QueuedMessage[];
} {
  const ref = { projectDir, sessionId };
  const base = rebaseOnPersistedWorkflowState(ref, state);
  const messages: QueuedMessage[] = [];
  for (const message of base.messageQueue) {
    if (!isQueuedMessagePendingDelivery(message)) continue;
    if (claimQueuedMessage(ref, message.id, 'prompt')) messages.push(message);
  }
  return { state: base, messages };
}

export function releaseQueueMessagesForPrompt(
  ref: SessionRef,
  messages: readonly Pick<QueuedMessage, 'id'>[],
): void {
  for (const message of messages) releaseQueuedMessage(ref, message.id, 'prompt');
}

export function commitQueueMessagesDrained({
  projectDir,
  sessionId,
  state,
  messages,
  bus,
}: QueueStateMutationOptions & { messages: readonly QueuedMessage[] }): {
  state: WorkflowState;
  count: number;
} {
  if (messages.length === 0) return { state, count: 0 };

  const ref = { projectDir, sessionId };
  const base = rebaseOnPersistedWorkflowState(ref, state);
  const ids = new Set(messages.map((message) => message.id));
  const pending = base.messageQueue.filter(
    (message) => isQueuedMessagePendingDelivery(message) && ownerFor(ref, message.id) !== 'native',
  );
  const drainable = pending.filter((message) => ids.has(message.id));

  if (
    drainable.length === 0 ||
    pending.length !== drainable.length ||
    base.messageQueue.some(
      (message) =>
        isQueuedMessagePendingDelivery(message) && ownerFor(ref, message.id) === 'native',
    )
  ) {
    releaseQueueMessagesForPrompt(ref, messages);
    return { state: base, count: 0 };
  }

  try {
    const next = transitionAndSave(
      ref,
      base,
      { type: 'DRAIN_QUEUE' },
      { expectedRevision: base.stateRevision },
    );
    bus.publish({
      type: 'queue_drained',
      ts: Date.now(),
      phase: next.phase,
      count: drainable.length,
      ids: drainable.map((message) => message.id),
    });
    return { state: next, count: drainable.length };
  } finally {
    releaseQueueMessagesForPrompt(ref, messages);
  }
}

export function drainQueue({ projectDir, sessionId, state, bus }: QueueStateMutationOptions): {
  state: WorkflowState;
  messages: QueuedMessage[];
} {
  const read = readQueueForPrompt({ projectDir, sessionId, state });
  if (read.messages.length === 0) return read;

  const committed = commitQueueMessagesDrained({
    projectDir,
    sessionId,
    state: read.state,
    messages: read.messages,
    bus,
  });

  return { state: committed.state, messages: read.messages };
}
