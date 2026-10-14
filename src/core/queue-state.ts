import type { QueuedMessage, WorkflowState } from './schemas/workflow.js';

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
