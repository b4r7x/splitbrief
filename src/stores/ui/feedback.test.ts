import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { feedbackStore } from './feedback.js';

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

    // setError persists and does not auto-clear.
    feedbackStore.setError('persistent');
    expect(feedbackStore.get().message).toBe('persistent');
    expect(feedbackStore.get().isError).toBe(true);
    vi.advanceTimersByTime(5000);
    expect(feedbackStore.get().message).toBe('persistent');
    expect(feedbackStore.get().isError).toBe(true);

    // setError(null) clears the error.
    feedbackStore.setError(null);
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
});
