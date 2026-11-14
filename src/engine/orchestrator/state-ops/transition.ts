import type { WorkflowState } from '../../../core/schemas/workflow/state.js';
import { transition } from '../../../core/state/machine.js';
import type { MachineAction } from '../../../core/state/types.js';
import type { SessionRef } from '../../../core/types/session-ref.js';
import { mutateState } from './commit.js';
import type { StateMutationOptions } from './errors.js';

/** One change in a list save: a machine action, or a derive over the state the earlier steps made. */
export type StateStep = MachineAction | ((state: WorkflowState) => WorkflowState);

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

function applyTransition(base: WorkflowState, action: MachineAction): WorkflowState {
  if (
    action.type === 'ENQUEUE_USER_MSG' &&
    base.messageQueue.some((message) => message.id === action.message.id)
  ) {
    return base;
  }
  return transition(base, action);
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
    derive: (base) => applyTransition(base, action),
  });
}

/**
 * Saves every step in one write over the persisted head, so a stop leaves all of them or none.
 * A conflict fails the save, unless `retryWhile` names the head it may derive the steps again on.
 */
export function transitionsAndSave(
  ref: SessionRef,
  state: WorkflowState,
  steps: readonly StateStep[],
  options: StateMutationOptions & { retryWhile?: (head: WorkflowState) => boolean },
): WorkflowState {
  const { retryWhile, ...mutation } = options;
  return mutateState({
    ref,
    state,
    operation: steps.some((step) => typeof step !== 'function' && queueAction(step))
      ? 'queue'
      : 'transition',
    options: mutation,
    rederivable: retryWhile !== undefined,
    mergeQueue: false,
    retryWhile,
    derive: (base) =>
      steps.reduce(
        (next, step) => (typeof step === 'function' ? step(next) : applyTransition(next, step)),
        base,
      ),
  });
}
