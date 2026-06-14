import { createStore, storeBase } from '../create-store.js';

interface CompletionState {
  open: boolean;
}

const initial: CompletionState = { open: false };

const store = createStore<CompletionState>(initial);

export const completionStore = {
  ...storeBase(store),
  setOpen: (open: boolean) => {
    if (store.get().open === open) return;
    store.set({ open });
  },
};
