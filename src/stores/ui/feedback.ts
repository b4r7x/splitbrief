import { createStore, storeBase } from '../create-store.js';
import { subscribeFeedbackErrors, subscribeFeedbackReset } from '../channels/feedback.js';

const FEEDBACK_AUTO_CLEAR_MS = 3000;
const FEEDBACK_ERROR_AUTO_CLEAR_MS = 5000;
// About 200 words a minute: a message longer than its base hold stays until it can be read.
const FEEDBACK_READ_MS_PER_CHAR = 60;

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

const scheduleAutoClear = (ms: number, msg: string) => {
  clearTimer = setTimeout(clearFeedback, Math.max(ms, msg.length * FEEDBACK_READ_MS_PER_CHAR));
};

const setError = (msg: string | null) => {
  clearTimeout(clearTimer);
  clearTimer = undefined;
  if (msg) scheduleAutoClear(FEEDBACK_ERROR_AUTO_CLEAR_MS, msg);
  store.set({ message: msg, isError: msg !== null });
};

const setMessage = (msg: string | null) => {
  clearTimeout(clearTimer);
  clearTimer = undefined;
  if (msg) scheduleAutoClear(FEEDBACK_AUTO_CLEAR_MS, msg);
  store.set({ message: msg, isError: false });
};

const setTransientError = (msg: string) => {
  clearTimeout(clearTimer);
  scheduleAutoClear(FEEDBACK_AUTO_CLEAR_MS, msg);
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
