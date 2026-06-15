import { createStore, storeBase } from '../create-store.js';
import { subscribeFeedbackErrors } from '../channels/feedback.js';

const FEEDBACK_AUTO_CLEAR_MS = 3000;

interface FeedbackState {
  message: string | null;
  isError: boolean;
}

const initial: FeedbackState = { message: null, isError: false };

const store = createStore<FeedbackState>(initial);

let clearTimer: ReturnType<typeof setTimeout> | undefined;

const clearFeedback = () => {
  clearTimer = undefined;
  store.set({ message: null, isError: false });
};

const scheduleAutoClear = () => {
  clearTimer = setTimeout(clearFeedback, FEEDBACK_AUTO_CLEAR_MS);
};

const setError = (msg: string | null) => {
  clearTimeout(clearTimer);
  clearTimer = undefined;
  store.set({ message: msg, isError: msg !== null });
};

const setMessage = (msg: string | null) => {
  clearTimeout(clearTimer);
  clearTimer = undefined;
  if (msg) scheduleAutoClear();
  store.set({ message: msg, isError: false });
};

const setTransientError = (msg: string) => {
  clearTimeout(clearTimer);
  scheduleAutoClear();
  store.set({ message: msg, isError: true });
};

subscribeFeedbackErrors(setError);

export const feedbackStore = {
  ...storeBase(store),
  setError,
  setMessage,
  setTransientError,
  reset: () => {
    clearTimeout(clearTimer);
    clearTimer = undefined;
    store.reset();
  },
};
