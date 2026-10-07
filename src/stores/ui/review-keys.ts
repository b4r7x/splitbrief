import { createStore, storeBase } from '../create-store.js';

interface ReviewKeysState {
  commenting: boolean;
}

const initial: ReviewKeysState = { commenting: false };

const store = createStore<ReviewKeysState>(initial);

// While the composer draft holds a comment on a review gate, the keys belong to the comment: the
// rows stop answering, the legend names `⏎ send · esc back`, and esc cancels the comment. The
// composer writes that condition here the moment it computes it, so the key legend and the key
// handlers read one value instead of deriving the same truth twice.
export const reviewKeysStore = {
  ...storeBase(store),
  setCommenting: (commenting: boolean) => {
    if (store.get().commenting === commenting) return;
    store.set({ commenting });
  },
};
