import { createStore, storeBase } from '../create-store.js';

const store = createStore<number | null>(null);

export const resultMenuStore = {
  ...storeBase(store),
  setHeight: (height: number | null) => store.set(height),
};
