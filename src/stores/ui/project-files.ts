import { createStore, storeBase } from '../create-store.js';

const store = createStore<{ refreshEpoch: number }>({ refreshEpoch: 0 });

export const projectFilesStore = {
  ...storeBase(store),
  requestRefresh: () => store.set((prev) => ({ refreshEpoch: prev.refreshEpoch + 1 })),
};
