import { isQueuedMessageClearable, isQueuedMessagePendingDelivery } from '../../queue/state.js';
import type { WorkflowState } from '../../schemas/workflow/state.js';
import { assertNever } from '../../../utils/type-guards.js';
import type { MachineAction } from '../types.js';

type FamilyAction = Extract<
  MachineAction,
  {
    type:
      | 'DECIDE_FOR_ME'
      | 'ENQUEUE_USER_MSG'
      | 'MARK_INJECTING_NATIVE'
      | 'MARK_DELIVERED_NATIVE'
      | 'MARK_NATIVE_DELIVERY_FAILED'
      | 'MARK_POSSIBLE_DUPLICATE'
      | 'DRAIN_QUEUE'
      | 'CLEAR_QUEUE';
  }
>;

export function transitionQueue(
  state: WorkflowState,
  action: FamilyAction,
  now: Date,
): WorkflowState {
  switch (action.type) {
    case 'DECIDE_FOR_ME':
      return { ...state, decideForMe: true };

    case 'ENQUEUE_USER_MSG':
      return { ...state, messageQueue: [...state.messageQueue, action.message] };

    case 'MARK_INJECTING_NATIVE':
      return {
        ...state,
        ...(action.attempt === undefined ? {} : { attempt: action.attempt }),
        messageQueue: state.messageQueue.map((m) =>
          m.id === action.id ? { ...m, nativeDeliveryState: 'injecting' } : m,
        ),
      };

    case 'MARK_DELIVERED_NATIVE':
      return {
        ...state,
        messageQueue: state.messageQueue.map((m) =>
          m.id === action.id
            ? {
                ...m,
                deliveredViaNative: true,
                nativeDeliveryState: 'delivered',
                ...(action.via === 'mid-call' && { deliveredMidCall: true }),
              }
            : m,
        ),
      };

    case 'MARK_NATIVE_DELIVERY_FAILED':
      return {
        ...state,
        messageQueue: state.messageQueue.map((m) =>
          m.id === action.id && m.nativeDeliveryState === 'injecting'
            ? { ...m, nativeDeliveryState: 'pending' }
            : m,
        ),
      };

    case 'MARK_POSSIBLE_DUPLICATE':
      return {
        ...state,
        messageQueue: state.messageQueue.map((m) =>
          m.id === action.id ? { ...m, possibleDuplicate: true } : m,
        ),
      };

    case 'DRAIN_QUEUE': {
      const ts = now.toISOString();
      const ids = action.ids === undefined ? undefined : new Set(action.ids);
      const destination = action.destination ?? 'implementer';
      return {
        ...state,
        messageQueue: state.messageQueue.map((m) => {
          if (ids !== undefined && !ids.has(m.id)) return m;
          if (destination === 'reviewer') {
            if (m.deliveredTo?.reviewer !== undefined) return m;
            return {
              ...m,
              deliveredTo: { ...m.deliveredTo, reviewer: ts },
              ...(action.via === 'mid-call' && { deliveredMidCall: true }),
            };
          }
          if (!isQueuedMessagePendingDelivery(m)) return m;
          return {
            ...m,
            drainedAt: ts,
            deliveredTo: { ...m.deliveredTo, implementer: ts },
            ...(action.via === 'mid-call' && { deliveredMidCall: true }),
          };
        }),
      };
    }

    case 'CLEAR_QUEUE':
      return {
        ...state,
        messageQueue: state.messageQueue.filter((message) => !isQueuedMessageClearable(message)),
      };

    default:
      return assertNever(action);
  }
}
