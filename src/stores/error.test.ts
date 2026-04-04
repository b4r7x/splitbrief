import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { feedbackStore } from './error.js';

describe('feedbackStore', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    feedbackStore.reset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts with null message', () => {
    expect(feedbackStore.get().message).toBeNull();
    expect(feedbackStore.get().isError).toBe(false);
  });

  it('sets error message with isError true', () => {
    feedbackStore.setError('something broke');
    expect(feedbackStore.get().message).toBe('something broke');
    expect(feedbackStore.get().isError).toBe(true);
  });

  it('clears error with setError(null)', () => {
    feedbackStore.setError('oops');
    feedbackStore.setError(null);
    expect(feedbackStore.get().message).toBeNull();
  });

  it('sets informational message with isError false', () => {
    feedbackStore.setMessage('saved');
    expect(feedbackStore.get().message).toBe('saved');
    expect(feedbackStore.get().isError).toBe(false);
  });

  it('auto-clears informational messages after 3 seconds', () => {
    feedbackStore.setMessage('temporary');
    expect(feedbackStore.get().message).toBe('temporary');

    vi.advanceTimersByTime(3000);
    expect(feedbackStore.get().message).toBeNull();
    expect(feedbackStore.get().isError).toBe(false);
  });

  it('does not auto-clear error messages', () => {
    feedbackStore.setError('persistent');
    vi.advanceTimersByTime(5000);
    expect(feedbackStore.get().message).toBe('persistent');
    expect(feedbackStore.get().isError).toBe(true);
  });
});
