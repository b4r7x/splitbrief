import { createStore, storeBase } from '../create-store.js';

export const MAX_PALETTE_MRU = 20;

interface PaletteMruState {
  ids: string[];
}

const initial: PaletteMruState = { ids: [] };

const store = createStore<PaletteMruState>(initial);

function record(id: string): void {
  store.set(state => ({
    ids: [id, ...state.ids.filter(x => x !== id)].slice(0, MAX_PALETTE_MRU),
  }));
}

function getRank(id: string): number {
  const index = store.get().ids.indexOf(id);
  return index === -1 ? 0 : index + 1;
}

// Test escape hatch — see docs/STORES.md#test-escape-hatches. Do not use outside tests.
function __testReset(): void {
  store.set(initial);
}

export const paletteMruStore = {
  ...storeBase(store),
  record,
  getRank,
  __testReset,
};
