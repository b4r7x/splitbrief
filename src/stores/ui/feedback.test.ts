import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { feedbackStore } from './feedback.js';
import { publishFeedbackReset } from '../channels/feedback.js';

describe('feedbackStore', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    feedbackStore.reset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('covers set/auto-clear/error/reset end-to-end', () => {
    // setMessage sets informational (non-error) state.
    feedbackStore.setMessage('saved');
    expect(feedbackStore.get().message).toBe('saved');
    expect(feedbackStore.get().isError).toBe(false);

    // Informational messages auto-clear after 3s.
    vi.advanceTimersByTime(3000);
    expect(feedbackStore.get().message).toBeNull();
    expect(feedbackStore.get().isError).toBe(false);

    // setError(null) clears the error.
    feedbackStore.setError('persistent');
    feedbackStore.setError(null);
    expect(feedbackStore.get().message).toBeNull();
    expect(feedbackStore.get().isError).toBe(false);

    feedbackStore.setTransientError('temporary failure');
    expect(feedbackStore.get().message).toBe('temporary failure');
    expect(feedbackStore.get().isError).toBe(true);
    vi.advanceTimersByTime(3000);
    expect(feedbackStore.get().message).toBeNull();
    expect(feedbackStore.get().isError).toBe(false);

    // reset cancels the pending auto-clear timer and clears state.
    feedbackStore.setMessage('will be cleared');
    feedbackStore.reset();
    expect(feedbackStore.get().message).toBeNull();
    vi.advanceTimersByTime(3000);
    expect(feedbackStore.get().message).toBeNull();
    expect(feedbackStore.get().isError).toBe(false);
  });

  it('setError auto-clears after the 5s error TTL', () => {
    feedbackStore.setError('persistent');
    expect(feedbackStore.get().message).toBe('persistent');
    expect(feedbackStore.get().isError).toBe(true);

    vi.advanceTimersByTime(4999);
    expect(feedbackStore.get().message).toBe('persistent');

    vi.advanceTimersByTime(1);
    expect(feedbackStore.get().message).toBeNull();
    expect(feedbackStore.get().isError).toBe(false);
  });

  it('transient errors keep the 3s TTL', () => {
    feedbackStore.setTransientError('temporary failure');
    expect(feedbackStore.get().message).toBe('temporary failure');

    vi.advanceTimersByTime(2999);
    expect(feedbackStore.get().message).toBe('temporary failure');

    vi.advanceTimersByTime(1);
    expect(feedbackStore.get().message).toBeNull();
    expect(feedbackStore.get().isError).toBe(false);
  });

  it('a later setError replaces a pending setMessage', () => {
    feedbackStore.setMessage('saved');
    feedbackStore.setError('Connection lost');

    expect(feedbackStore.get().message).toBe('Connection lost');
    expect(feedbackStore.get().isError).toBe(true);

    vi.advanceTimersByTime(3000);
    expect(feedbackStore.get().message).toBe('Connection lost');

    vi.advanceTimersByTime(2000);
    expect(feedbackStore.get().message).toBeNull();
  });

  it('publishFeedbackReset clears feedback immediately', () => {
    feedbackStore.setError('persistent');
    expect(feedbackStore.get().message).toBe('persistent');

    publishFeedbackReset();
    expect(feedbackStore.get().message).toBeNull();
    expect(feedbackStore.get().isError).toBe(false);

    vi.advanceTimersByTime(5000);
    expect(feedbackStore.get().message).toBeNull();
  });
});
