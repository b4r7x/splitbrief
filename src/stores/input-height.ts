import { createStore, storeBase } from './create-store.js';

const INITIAL_ROWS = 3;

interface InputHeightState {
  rows: number;
}

const initial: InputHeightState = { rows: INITIAL_ROWS };

const store = createStore<InputHeightState>(initial);

function normalizeRows(rows: number): number {
  if (!Number.isFinite(rows)) return 1;
  return Math.max(1, Math.floor(rows));
}

export const inputHeightStore = {
  ...storeBase(store),
  setRows: (rows: number) => {
    const nextRows = normalizeRows(rows);
    if (store.get().rows === nextRows) return;
    store.set({ rows: nextRows });
  },
};
