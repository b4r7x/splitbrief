import { createStore, storeBase } from './create-store.js';

interface ErrorState {
  message: string | null;
  isError: boolean;
}

const store = createStore<ErrorState>({ message: null, isError: false });

let clearTimer: ReturnType<typeof setTimeout> | undefined;

const setError = (msg: string | null) => {
  clearTimeout(clearTimer);
  store.set({ message: msg, isError: true });
};

const setMessage = (msg: string | null) => {
  clearTimeout(clearTimer);
  if (msg) {
    clearTimer = setTimeout(() => store.set({ message: null, isError: false }), 3000);
  }
  store.set({ message: msg, isError: false });
};

export const feedbackStore = {
  ...storeBase(store),
  setError,
  setMessage,
};
