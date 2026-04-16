import { createStore, storeBase } from './create-store.js';

interface AbortState {
  pending: boolean;
}

const initial: AbortState = { pending: false };
const store = createStore<AbortState>(initial);

let timer: ReturnType<typeof setTimeout> | null = null;
const WINDOW_MS = 2000;

export const abortStore = {
  ...storeBase(store),
  markPending: () => {
    if (timer) clearTimeout(timer);
    store.set({ pending: true });
    timer = setTimeout(() => {
      store.set({ pending: false });
      timer = null;
    }, WINDOW_MS);
  },
  clear: () => {
    if (timer) { clearTimeout(timer); timer = null; }
    store.set({ pending: false });
  },
};
