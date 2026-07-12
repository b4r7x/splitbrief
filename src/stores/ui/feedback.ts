import { createStore, storeBase } from '../create-store.js';
import { subscribeFeedbackErrors, subscribeFeedbackReset } from '../channels/feedback.js';

const FEEDBACK_AUTO_CLEAR_MS = 3000;
const FEEDBACK_ERROR_AUTO_CLEAR_MS = 5000;

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

const scheduleAutoClear = (ms: number) => {
  clearTimer = setTimeout(clearFeedback, ms);
};

const setError = (msg: string | null) => {
  clearTimeout(clearTimer);
  clearTimer = undefined;
  if (msg) scheduleAutoClear(FEEDBACK_ERROR_AUTO_CLEAR_MS);
  store.set({ message: msg, isError: msg !== null });
};

const setMessage = (msg: string | null) => {
  clearTimeout(clearTimer);
  clearTimer = undefined;
  if (msg) scheduleAutoClear(FEEDBACK_AUTO_CLEAR_MS);
  store.set({ message: msg, isError: false });
};

const setTransientError = (msg: string) => {
  clearTimeout(clearTimer);
  scheduleAutoClear(FEEDBACK_AUTO_CLEAR_MS);
  store.set({ message: msg, isError: true });
};

const reset = () => {
  clearTimeout(clearTimer);
  clearTimer = undefined;
  store.reset();
};

subscribeFeedbackErrors(setError);
subscribeFeedbackReset(reset);

export const feedbackStore = {
  ...storeBase(store),
  setError,
  setMessage,
  setTransientError,
  reset,
};
