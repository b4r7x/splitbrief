import { createStore, storeBase } from '../create-store.js';
import type { EngineEvent } from '../../engine/events/types.js';

export interface EventsState {
  events: EngineEvent[];
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
export const MAX_MERGED_TEXT_LENGTH = 500_000;

export function mergeEvent(events: EngineEvent[], event: EngineEvent): EngineEvent[] {
  const last = events[events.length - 1];
  if (event.type === 'planner_text' && last?.type === 'planner_text') {
    let mergedText = last.text + event.text;
    if (mergedText.length > MAX_MERGED_TEXT_LENGTH) {
      mergedText = mergedText.slice(-MAX_MERGED_TEXT_LENGTH);
    }
    const merged = { ...last, text: mergedText };
    const next = events.slice();
    next[next.length - 1] = merged;
    return next;
  }
  if (event.type === 'validate' && event.status === 'running' && last?.type === 'validate' && last.status === 'running') {
    const next = events.slice();
    next[next.length - 1] = event;
    return next;
  }
  if (event.type === 'planner_heartbeat' && last?.type === 'planner_heartbeat') {
    const next = events.slice();
    next[next.length - 1] = event;
    return next;
  }
  if (events.length >= MAX_EVENTS) {
    return [...events.slice(1), event];
  }
  return [...events, event];
}
