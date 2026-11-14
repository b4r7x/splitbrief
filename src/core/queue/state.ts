import { randomUUID } from 'node:crypto';
import type { Phase } from '../schemas/enums.js';
import type { WorkflowState } from '../schemas/workflow/state.js';
import type { QueuedMessage } from '../schemas/workflow/queue.js';
import type { UserMessageInput } from '../types/user-input.js';
import { nowIso } from '../../utils/format/time.js';
import { phaseStage } from '../phases/rail.js';

/**
 * The seat that reads a message typed now: REVIEW while a task review runs inside the build
 * phase, as it reads every unread message at its verdict call, else the seat of the phase's stage.
 * Under REVIEW None no review reads it, so a due task review names BUILD while a brief is left,
 * and no seat reads a message after the last brief.
 */
export function messageSeat(
  phase: Phase,
  reviewing: boolean,
  reviewNone: boolean,
  briefLeft: boolean,
): ReturnType<typeof phaseStage> {
  if (!reviewNone) return reviewing ? 'review' : phaseStage(phase);
  const stage = phaseStage(phase);
  return stage === 'review' || (stage === 'build' && !briefLeft) ? null : stage;
}

/** A message the user sent, as the queue holds it until a seat reads it. */
export function queuedUserMessage(input: UserMessageInput, phase: Phase): QueuedMessage {
  return {
    id: randomUUID(),
    ...input,
    queuedAt: nowIso(),
    phase,
    deliveredViaNative: false,
    nativeDeliveryState: 'pending',
    origin: 'user-input',
  };
}

export function isQueuedMessagePendingDelivery(message: QueuedMessage): boolean {
  return (
    message.deliveredTo?.implementer === undefined &&
    !message.drainedAt &&
    !message.deliveredViaNative &&
    message.nativeDeliveryState === 'pending'
  );
}

export function isQueuedMessagePendingReviewer(message: QueuedMessage): boolean {
  return isQueuedMessagePendingDelivery(message) && message.deliveredTo?.reviewer === undefined;
}

export function isQueuedMessagePendingFirstDelivery(message: QueuedMessage): boolean {
  return (
    message.deliveredTo?.implementer === undefined &&
    message.deliveredTo?.reviewer === undefined &&
    !message.drainedAt &&
    !message.deliveredViaNative &&
    !message.deliveredMidCall &&
    message.nativeDeliveryState !== 'delivered'
  );
}

export function isQueuedMessageClearable(message: QueuedMessage): boolean {
  return isQueuedMessagePendingFirstDelivery(message);
}

function recoverInterruptedQueuedMessage(message: QueuedMessage): QueuedMessage {
  if (message.deliveredViaNative || message.nativeDeliveryState === 'delivered') {
    return { ...message, deliveredViaNative: true, nativeDeliveryState: 'delivered' };
  }
  if (message.nativeDeliveryState === 'injecting') {
    return { ...message, nativeDeliveryState: 'pending' };
  }
  return message;
}

export function recoverInterruptedNativeDeliveries(state: WorkflowState): WorkflowState {
  let changed = false;
  const messageQueue = state.messageQueue.map((message) => {
    const normalized = recoverInterruptedQueuedMessage(message);
    changed ||= normalized !== message;
    return normalized;
  });
  return changed ? { ...state, messageQueue } : state;
}
