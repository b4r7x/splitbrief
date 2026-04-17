import { createStore, storeBase } from '../create-store.js';

interface AbortState {
  pending: boolean;
}

const initial: AbortState = { pending: false };
const store = createStore<AbortState>(initial);

const WINDOW_MS = 2000;
let pendingTimer: ReturnType<typeof setTimeout> | null = null;

function markPending(): void {
  if (pendingTimer) clearTimeout(pendingTimer);
  store.set({ pending: true });
  pendingTimer = setTimeout(() => {
    store.set({ pending: false });
    pendingTimer = null;
  }, WINDOW_MS);
}

function clear(): void {
  if (pendingTimer) {
    clearTimeout(pendingTimer);
    pendingTimer = null;
  }
  store.set({ pending: false });
}

export const abortStore = {
  ...storeBase(store),
  markPending,
  clear,
};
