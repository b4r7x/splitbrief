import { createStore, storeBase } from '../create.js';
import { subscribeFeedbackErrors, subscribeFeedbackReset } from '../channels/feedback.js';

const FEEDBACK_AUTO_CLEAR_MS = 3000;
const FEEDBACK_ERROR_AUTO_CLEAR_MS = 5000;
// About 200 words a minute: a message longer than its base hold stays until it can be read.
const FEEDBACK_READ_MS_PER_CHAR = 60;

/** How a message reads: a failure, a refusal or a step the user must take, or a report. */
export type FeedbackSeverity = 'error' | 'warning' | 'info';

export interface FeedbackState {
  message: string | null;
  severity: FeedbackSeverity;
}

const initial: FeedbackState = { message: null, severity: 'info' };

const store = createStore<FeedbackState>(initial);

let clearTimer: ReturnType<typeof setTimeout> | undefined;

const clearFeedback = () => {
  clearTimer = undefined;
  store.set(initial);
};

const scheduleAutoClear = (ms: number, msg: string) => {
  clearTimer = setTimeout(clearFeedback, Math.max(ms, msg.length * FEEDBACK_READ_MS_PER_CHAR));
};

const show = (msg: string | null, severity: FeedbackSeverity, holdMs: number) => {
  clearTimeout(clearTimer);
  clearTimer = undefined;
  if (msg) scheduleAutoClear(holdMs, msg);
  store.set(msg === null ? initial : { message: msg, severity });
};

const setError = (msg: string | null) => show(msg, 'error', FEEDBACK_ERROR_AUTO_CLEAR_MS);

// A refusal asks for a step from the user, so it stays as long as a failure does.
const setWarning = (msg: string | null) => show(msg, 'warning', FEEDBACK_ERROR_AUTO_CLEAR_MS);

const setMessage = (msg: string | null) => show(msg, 'info', FEEDBACK_AUTO_CLEAR_MS);

const setTransientError = (msg: string) => show(msg, 'error', FEEDBACK_AUTO_CLEAR_MS);

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
  setWarning,
  setMessage,
  setTransientError,
  reset,
};
