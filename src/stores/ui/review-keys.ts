import { createStore, storeBase } from '../create-store.js';

interface ReviewKeysState {
  armed: boolean;
}

const initial: ReviewKeysState = { armed: false };

const store = createStore<ReviewKeysState>(initial);

// A review gate settles on one key only while the composer draft is empty and nothing else owns
// the keyboard. The composer writes that condition here the moment it computes it, so the key
// legend and the key handler read one value instead of deriving the same truth twice.
export const reviewKeysStore = {
  ...storeBase(store),
  setArmed: (armed: boolean) => {
    if (store.get().armed === armed) return;
    store.set({ armed });
  },
};
