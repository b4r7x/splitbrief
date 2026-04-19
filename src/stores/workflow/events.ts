import { createStore, storeBase } from '../create-store.js';
import type { TuiEvent } from '../../features/workflow/types.js';

export interface EventsState {
  events: TuiEvent[];
}

const initial: EventsState = { events: [] };

const store = createStore<EventsState>(initial);

// Test escape hatch — see docs/STORES.md#test-escape-hatches. Do not use outside tests.
function __testReset(next?: Partial<EventsState>): void {
  store.set(next ? { ...initial, ...next } : initial);
}

// Test escape hatch — see docs/STORES.md#test-escape-hatches. Do not use outside tests.
// Production use is limited to workflow/actions.ts (the dispatcher).
export const _eventsInternal = { set: store.set };

export const eventsStore = {
  ...storeBase(store),
  __testReset,
};

export const MAX_EVENTS = 10_000;

export function mergeEvent(events: TuiEvent[], event: TuiEvent): TuiEvent[] {
  const last = events[events.length - 1];
  if (event.type === 'planner-text' && last?.type === 'planner-text') {
    const merged = { ...last, text: last.text + event.text };
    const next = events.slice();
    next[next.length - 1] = merged;
    return next;
  }
  if (event.type === 'validate' && event.status === 'running' && last?.type === 'validate' && last.status === 'running') {
    const next = events.slice();
    next[next.length - 1] = event;
    return next;
  }
  if (events.length >= MAX_EVENTS) {
    return [...events.slice(1), event];
  }
  return [...events, event];
}
