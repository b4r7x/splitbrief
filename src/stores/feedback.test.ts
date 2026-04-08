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

  it('reset clears pending auto-clear timer', () => {
    feedbackStore.setMessage('will be cleared');
    feedbackStore.reset();
    expect(feedbackStore.get().message).toBeNull();
    vi.advanceTimersByTime(3000);
    expect(feedbackStore.get().message).toBeNull();
    expect(feedbackStore.get().isError).toBe(false);
  });
});
