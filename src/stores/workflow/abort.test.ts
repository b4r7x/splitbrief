import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { abortStore } from './abort.js';

describe('abortStore', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    abortStore.clear();
  });

  afterEach(() => {
    abortStore.clear();
    vi.useRealTimers();
  });

  it('arms a kind and disarms after the 2s window', () => {
    abortStore.arm('interrupt');
    expect(abortStore.get().armed).toBe('interrupt');

    vi.advanceTimersByTime(1999);
    expect(abortStore.get().armed).toBe('interrupt');

    vi.advanceTimersByTime(1);
    expect(abortStore.get().armed).toBe('none');
  });

  it('arming twice restarts the window and replaces the kind', () => {
    abortStore.arm('exit');
    vi.advanceTimersByTime(1500);
    expect(abortStore.get().armed).toBe('exit');

    abortStore.arm('cancel');
    expect(abortStore.get().armed).toBe('cancel');

    vi.advanceTimersByTime(1500);
    expect(abortStore.get().armed).toBe('cancel');

    vi.advanceTimersByTime(500);
    expect(abortStore.get().armed).toBe('none');
  });

  it('clear cancels the pending timer and disarms immediately', () => {
    abortStore.arm('exit');
    abortStore.clear();
    expect(abortStore.get().armed).toBe('none');

    vi.advanceTimersByTime(2000);
    expect(abortStore.get().armed).toBe('none');
  });
});
