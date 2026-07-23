import type { QueuedMessage, WorkflowState } from '../../../core/schemas/workflow.js';
import { mergePersistedMessageQueue } from '../state-ops.js';
import { saveState } from '../../../core/state/persistence.js';
import { isQueuedMessagePendingDelivery } from '../../../core/queue-state.js';
import { nowIso } from '../../../utils/format-time.js';
import type { QueueStateMutationOptions } from './types.js';

export function readQueueForPrompt({
  projectDir,
  sessionId,
  state,
}: Omit<QueueStateMutationOptions, 'bus'>): {
  state: WorkflowState;
  messages: QueuedMessage[];
} {
  const base = mergePersistedMessageQueue({ projectDir, sessionId }, state);
  return { state: base, messages: base.messageQueue.filter(isQueuedMessagePendingDelivery) };
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

  const base = mergePersistedMessageQueue({ projectDir, sessionId }, state);
  const ids = new Set(messages.map((message) => message.id));
  const drainedAt = nowIso();
  const drainedIds: string[] = [];
  let count = 0;
  const messageQueue = base.messageQueue.map((message) => {
    if (!ids.has(message.id) || !isQueuedMessagePendingDelivery(message)) return message;
    count += 1;
    drainedIds.push(message.id);
    return { ...message, drainedAt };
  });

  if (count === 0) return { state: base, count: 0 };

  const next = { ...base, messageQueue };
  saveState({ projectDir, sessionId }, next);
  bus.publish({
    type: 'queue_drained',
    ts: Date.now(),
    phase: next.phase,
    count,
    ids: drainedIds,
  });

  return { state: next, count };
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
