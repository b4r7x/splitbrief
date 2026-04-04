import { createStore, storeBase } from './create-store.js';

interface ErrorState {
  message: string | null;
}

const store = createStore<ErrorState>({ message: null });

export const errorStore = {
  ...storeBase(store),
  setError: (msg: string | null) => store.set({ message: msg }),
};
