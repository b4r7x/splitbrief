import { createStore, storeBase } from '../create-store.js';

export interface ComposerDraftRequest {
  epoch: number;
  value: string;
}

const store = createStore<{ request: ComposerDraftRequest | null }>({ request: null });

export const composerDraftStore = {
  ...storeBase(store),
  request: (value: string) =>
    store.set((s) => ({ request: { epoch: (s.request?.epoch ?? 0) + 1, value } })),
  clear: () => store.set((s) => (s.request === null ? s : { request: null })),
};
