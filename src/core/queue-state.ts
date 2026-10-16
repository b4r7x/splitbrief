import type { Phase } from './schemas/enums.js';
import type { QueuedMessage, WorkflowState } from './schemas/workflow.js';
import { phaseStage } from './rail-stages.js';

/**
 * The seat that reads a message typed now: REVIEW while a task review runs inside the build
 * phase, as it reads every unread message at its verdict call, else the seat of the phase's stage.
 */
export function messageSeat(phase: Phase, reviewing: boolean): ReturnType<typeof phaseStage> {
  return reviewing ? 'review' : phaseStage(phase);
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
