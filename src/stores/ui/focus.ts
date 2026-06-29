import { createStore, storeBase } from '../create-store.js';

export type FocusRegion = 'brief';

export interface Focus {
  region: FocusRegion;
  index: number;
}

const store = createStore<Focus | null>(null);

export const focusStore = {
  ...storeBase(store),
  set: (region: FocusRegion, index: number) =>
    store.set((s) => (s?.region === region && s.index === index ? s : { region, index })),
  clear: () => store.set((s) => (s === null ? s : null)),
};
