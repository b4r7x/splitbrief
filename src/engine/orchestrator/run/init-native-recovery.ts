import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { StateAction, StateAuthorityReceipt } from '../../../core/state/types.js';
import { recoverInterruptedNativeDeliveries } from '../../../core/queue-state.js';
import { transitionAndSave } from '../state-ops.js';
import { workflowMutationOptions } from './authority.js';

export type RecoverNativeDeliveriesInput = {
  projectDir: string;
  sessionId: string;
  state: WorkflowState;
  authority: StateAuthorityReceipt | undefined;
  setTrackedState: (s: WorkflowState) => void;
};

/** Replays interrupted native message deliveries onto persisted state, returning the settled state. */
export function recoverNativeDeliveries(input: RecoverNativeDeliveriesInput): WorkflowState {
  const { projectDir, sessionId, state, authority, setTrackedState } = input;
  const recovered = recoverInterruptedNativeDeliveries(state);
  if (recovered === state) return state;

  let recoveredState = state;
  for (const [index, message] of state.messageQueue.entries()) {
    const normalized = recovered.messageQueue[index];
    if (normalized === undefined || normalized === message) continue;
    const action: StateAction =
      normalized.deliveredViaNative || normalized.nativeDeliveryState === 'delivered'
        ? { type: 'MARK_DELIVERED_NATIVE', id: message.id }
        : { type: 'MARK_NATIVE_DELIVERY_FAILED', id: message.id };
    recoveredState = transitionAndSave(
      { projectDir, sessionId },
      recoveredState,
      action,
      workflowMutationOptions(recoveredState, authority),
    );
    setTrackedState(recoveredState);
  }
  return recoveredState;
}
