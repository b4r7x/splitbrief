import type { EngineEvent } from '../../../engine/events/types.js';
import { createStore, storeBase } from '../../create-store.js';

export interface EventsState {
  events: EngineEvent[];
}

const initial: EventsState = { events: [] };

const store = createStore<EventsState>(initial);

// Test escape hatch — see docs/STORES-AND-UI.md#test-escape-hatches. Do not use outside tests.
function __testReset(next?: Partial<EventsState>): void {
  store.set(next ? { ...initial, ...next } : initial);
}

// Test escape hatch — see docs/STORES-AND-UI.md#test-escape-hatches. Do not use outside tests.
// Production use is limited to workflow/actions/ (the dispatcher).
export const _eventsInternal = { set: store.set };

export const eventsStore = {
  ...storeBase(store),
  __testReset,
};
