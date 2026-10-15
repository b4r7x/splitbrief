import { createStore, storeBase } from '../create-store.js';

interface ReviewKeysState {
  commenting: boolean;
  /** The user chose Request changes: the draft is the change request, also while it is empty. */
  requested: boolean;
}

const initial: ReviewKeysState = { commenting: false, requested: false };

const store = createStore<ReviewKeysState>(initial);

// While the composer draft holds a comment on a review gate, the keys belong to the comment: the
// rows stop answering, the legend names `⏎ send · esc back`, and esc cancels the comment. The
// composer writes that condition here the moment it computes it, so the key legend and the key
// handlers read one value instead of deriving the same truth twice.
export const reviewKeysStore = {
  ...storeBase(store),
  setCommenting: (commenting: boolean) => {
    if (store.get().commenting === commenting) return;
    store.set((s) => ({ ...s, commenting }));
  },
  requestComment: () => {
    if (store.get().requested) return;
    store.set((s) => ({ ...s, requested: true }));
  },
  endComment: () => {
    if (!store.get().requested) return;
    store.set((s) => ({ ...s, requested: false }));
  },
};
