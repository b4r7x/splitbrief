import { createStore, storeBase } from './create-store.js';

const FEEDBACK_AUTO_CLEAR_MS = 3000;

interface FeedbackState {
  message: string | null;
  isError: boolean;
}

const store = createStore<FeedbackState>({ message: null, isError: false });

let clearTimer: ReturnType<typeof setTimeout> | undefined;

const setError = (msg: string | null) => {
  clearTimeout(clearTimer);
  store.set({ message: msg, isError: msg !== null });
};

const setMessage = (msg: string | null) => {
  clearTimeout(clearTimer);
  if (msg) {
    clearTimer = setTimeout(() => store.set({ message: null, isError: false }), FEEDBACK_AUTO_CLEAR_MS);
  }
  store.set({ message: msg, isError: false });
};

export const feedbackStore = {
  ...storeBase(store),
  setError,
  setMessage,
  reset: () => {
    clearTimeout(clearTimer);
    clearTimer = undefined;
    store.reset();
  },
};
