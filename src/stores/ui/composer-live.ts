import { createStore, storeBase } from '../create-store.js';

interface ComposerLiveState {
  empty: boolean;
}

const initial: ComposerLiveState = { empty: true };
const store = createStore<ComposerLiveState>(initial);

export const composerLiveStore = {
  ...storeBase(store),
  setEmpty: (empty: boolean) => {
    if (store.get().empty === empty) return;
    store.set({ empty });
  },
};
