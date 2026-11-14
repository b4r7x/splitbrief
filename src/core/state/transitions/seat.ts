import type { WorkflowState } from '../../schemas/workflow/state.js';
import { assertNever } from '../../../utils/type-guards.js';
import type { MachineAction, StateAction } from '../types.js';

function markRecoveryApplying(
  state: WorkflowState,
  action: Extract<StateAction, { type: 'MARK_RECOVERY_APPLYING' }>,
): WorkflowState {
  if (!state.pendingRecovery) return state;
  return {
    ...state,
    pendingRecovery: {
      ...state.pendingRecovery,
      status: 'applying',
      selectedAction: action.action,
    },
  };
}

/**
 * A recovery action that names a BUILD profile pins the brief to it until the
 * brief settles; one that names none leaves an earlier pin in place, so a
 * reopen that restarts the interrupted brief keeps the profile.
 */
export function retryProfilePin(
  action: Extract<StateAction, { type: 'RESET_TASK' | 'RESTART_ATTEMPT_ON_SEAT' }>,
): Pick<WorkflowState, 'retryProfile'> {
  return action.profile === undefined
    ? {}
    : { retryProfile: { taskId: action.taskId, profile: action.profile } };
}

type FamilyAction = Extract<
  MachineAction,
  {
    type:
      | 'SET_SEAT_WAIT'
      | 'CLEAR_SEAT_WAIT'
      | 'SET_PENDING_RECOVERY'
      | 'MARK_RECOVERY_APPLYING'
      | 'RESOLVE_PENDING_RECOVERY'
      | 'RESTART_ATTEMPT_ON_SEAT'
      | 'RECORD_SEAT_SWITCH';
  }
>;

export function transitionSeat(
  state: WorkflowState,
  action: FamilyAction,
  now: Date,
): WorkflowState {
  switch (action.type) {
    case 'SET_SEAT_WAIT':
      return { ...state, seatWait: action.wait };

    case 'CLEAR_SEAT_WAIT':
      return { ...state, seatWait: undefined };

    case 'SET_PENDING_RECOVERY':
      return { ...state, pendingRecovery: action.issue };

    case 'MARK_RECOVERY_APPLYING':
      return markRecoveryApplying(state, action);

    case 'RESOLVE_PENDING_RECOVERY':
      return { ...state, pendingRecovery: undefined };

    case 'RESTART_ATTEMPT_ON_SEAT': {
      const idx = state.tasks.findIndex((t) => t.id === action.taskId);
      if (idx < 0) return state;
      return {
        ...state,
        currentTaskIndex: idx,
        pendingRecovery: undefined,
        ...retryProfilePin(action),
      };
    }

    case 'RECORD_SEAT_SWITCH':
      return {
        ...state,
        seatSwitches: [
          ...(state.seatSwitches ?? []),
          {
            ...(action.switchId !== undefined && { switchId: action.switchId }),
            seat: action.seat,
            from: action.from,
            to: action.to,
            ...(action.fromSeat !== undefined && { fromSeat: action.fromSeat }),
            ...(action.toSeat !== undefined && { toSeat: action.toSeat }),
            cause: action.cause,
            ...(action.accountCause !== undefined && { accountCause: action.accountCause }),
            ...(action.headline !== undefined && { headline: action.headline }),
            auto: action.auto,
            configRevision: action.configRevision,
            ts: now.toISOString(),
          },
        ],
      };

    default:
      return assertNever(action);
  }
}
