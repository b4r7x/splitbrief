import { createStore, storeBase } from '../create-store.js';

const store = createStore<number | null>(null);

export const hoverStore = {
  ...storeBase(store),
  set: (index: number) => store.set(index),
  clear: () => store.set(null),
};
