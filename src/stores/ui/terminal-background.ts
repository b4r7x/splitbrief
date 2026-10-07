import { createStore, storeBase } from '../create-store.js';

const store = createStore<string | undefined>(undefined);

export const terminalBackgroundStore = {
  ...storeBase(store),
  detected: (hex: string) => store.set(hex),
};
