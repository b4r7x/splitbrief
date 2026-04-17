import { createStore, storeBase } from '../create-store.js';
import type { Phase } from '../../core/types/state-actions.js';
import type { TuiEvent } from '../../features/workflow/types.js';

export interface LifecycleState {
  phase: Phase;
  cancelled: boolean;
  queueDepth: number;
}

const initial: LifecycleState = {
  phase: 'idle',
  cancelled: false,
  queueDepth: 0,
};

const store = createStore<LifecycleState>(initial);

export const lifecycleStore = {
  ...storeBase(store),
  set: store.set,
};

export function updatePhase(state: LifecycleState, event: TuiEvent): LifecycleState {
  if (event.type === 'planner-status' && state.phase !== event.phase) {
    return { ...state, phase: event.phase };
  }
  return state;
}

export function updateQueueDepth(state: LifecycleState, event: TuiEvent): LifecycleState {
  if (event.type === 'message-queued') {
    return { ...state, queueDepth: state.queueDepth + 1 };
  }
  if (event.type === 'queue-drained') {
    if (state.queueDepth === 0) return state;
    return { ...state, queueDepth: 0 };
  }
  if (event.type === 'queue-cleared') {
    const next = Math.max(0, state.queueDepth - event.count);
    if (next === state.queueDepth) return state;
    return { ...state, queueDepth: next };
  }
  return state;
}
