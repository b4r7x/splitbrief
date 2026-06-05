import { createStore, storeBase } from '../create-store.js';

export type ArmedKind = 'none' | 'exit' | 'interrupt' | 'cancel';

interface AbortState {
  armed: ArmedKind;
}

const initial: AbortState = { armed: 'none' };
const store = createStore<AbortState>(initial);

const WINDOW_MS = 2000;
let armTimer: ReturnType<typeof setTimeout> | null = null;

function arm(kind: Exclude<ArmedKind, 'none'>): void {
  if (armTimer) clearTimeout(armTimer);
  store.set({ armed: kind });
  armTimer = setTimeout(() => {
    store.set({ armed: 'none' });
    armTimer = null;
  }, WINDOW_MS);
}

function clear(): void {
  if (armTimer) {
    clearTimeout(armTimer);
    armTimer = null;
  }
  store.set({ armed: 'none' });
}

export const abortStore = {
  ...storeBase(store),
  arm,
  clear,
};
