import { createStore, storeBase } from '../create-store.js';
import type { Phase } from '../../core/schemas/enums.js';
import type { EngineEvent } from '../../engine/events/types.js';

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

// Test escape hatch — see docs/STORES.md#test-escape-hatches. Do not use outside tests.
function __testReset(next?: Partial<LifecycleState>): void {
  store.set(next ? { ...initial, ...next } : initial);
}

// Test escape hatch — see docs/STORES.md#test-escape-hatches. Do not use outside tests.
// Production use is limited to workflow/actions.ts (the dispatcher).
export const _lifecycleInternal = { set: store.set };

export const lifecycleStore = {
  ...storeBase(store),
  __testReset,
};

export function updatePhase(state: LifecycleState, event: EngineEvent): LifecycleState {
  if (event.type === 'planner_status' && state.phase !== event.phase) {
    return { ...state, phase: event.phase };
  }
  return state;
}

export function updateQueueDepth(state: LifecycleState, event: EngineEvent): LifecycleState {
  if (event.type === 'message_queued') {
    return { ...state, queueDepth: state.queueDepth + 1 };
  }
  if (event.type === 'queue_drained') {
    if (state.queueDepth === 0) return state;
    return { ...state, queueDepth: 0 };
  }
  if (event.type === 'queue_cleared') {
    const next = Math.max(0, state.queueDepth - event.count);
    if (next === state.queueDepth) return state;
    return { ...state, queueDepth: next };
  }
  return state;
}
