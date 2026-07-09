import { createStore, storeBase } from '../create-store.js';

type ExternalEditRequest = { status: 'idle' } | { status: 'requested'; ownerToken: number };

const store = createStore<ExternalEditRequest>({ status: 'idle' });

export const externalEditRequestStore = {
  ...storeBase(store),
  request: (ownerToken: number) => store.set({ status: 'requested', ownerToken }),
  consume: () => store.set({ status: 'idle' }),
};
