import { createStore, storeBase } from '../create-store.js';

export type DepartureKind = 'home' | 'quit';

/** Where the screen goes once the work that holds it settles, and the call that takes it there. */
export interface Departure {
  kind: DepartureKind;
  run: () => void;
}

const store = createStore<Departure | null>(null);

/** A quit replaces a queued home. A repeat, or a home behind a quit, changes nothing: false. */
function queue(next: Departure): boolean {
  const queued = store.get();
  if (queued?.kind === 'quit' || queued?.kind === next.kind) return false;
  store.set(next);
  return true;
}

/** Takes the queued departure off the queue, to run it or to drop it. */
function take(): Departure | null {
  const queued = store.get();
  store.set(null);
  return queued;
}

// Test escape hatch — see docs/STORES.md#test-escape-hatches. Do not use outside tests.
function __testReset(next: Departure | null = null): void {
  store.set(next);
}

export const departureStore = {
  ...storeBase(store),
  queue,
  take,
  __testReset,
};
