import type { QueuedMessage, WorkflowState } from './schemas/workflow.js';

export function isQueuedMessagePendingDelivery(message: QueuedMessage): boolean {
  return (
    !message.drainedAt && !message.deliveredViaNative && message.nativeDeliveryState === 'pending'
  );
}

export function isQueuedMessageClearable(message: QueuedMessage): boolean {
  return (
    !message.drainedAt && !message.deliveredViaNative && message.nativeDeliveryState !== 'delivered'
  );
}

function normalizeLoadedQueuedMessage(message: QueuedMessage): QueuedMessage {
  if (message.deliveredViaNative || message.nativeDeliveryState === 'delivered') {
    return { ...message, deliveredViaNative: true, nativeDeliveryState: 'delivered' };
  }
  if (message.nativeDeliveryState === 'injecting') {
    return { ...message, nativeDeliveryState: 'pending' };
  }
  return message;
}

export function normalizeLoadedWorkflowState(state: WorkflowState): WorkflowState {
  let changed = false;
  const messageQueue = state.messageQueue.map((message) => {
    const normalized = normalizeLoadedQueuedMessage(message);
    changed ||= normalized !== message;
    return normalized;
  });
  return changed ? { ...state, messageQueue } : state;
}
