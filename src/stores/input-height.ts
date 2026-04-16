import { createStore, storeBase } from './create-store.js';

interface InputHeightState {
  rows: number;
}

const initial: InputHeightState = { rows: 3 };

const store = createStore<InputHeightState>(initial);

export const inputHeightStore = {
  ...storeBase(store),
  setRows: (rows: number) => {
    if (store.get().rows === rows) return;
    store.set({ rows });
  },
};
