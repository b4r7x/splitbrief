import { describe, it, expect, beforeEach } from 'vitest';
import { focusStore } from './focus.js';

describe('focusStore', () => {
  beforeEach(() => {
    focusStore.reset();
  });

  it('sets and clears a focused region/index', () => {
    expect(focusStore.get()).toBeNull();
    focusStore.set('brief', 2);
    expect(focusStore.get()).toEqual({ region: 'brief', index: 2 });

    focusStore.clear();
    expect(focusStore.get()).toBeNull();
  });

  it('keeps a stable snapshot when set to the same region/index', () => {
    focusStore.set('brief', 0);
    const first = focusStore.get();
    focusStore.set('brief', 0);
    expect(focusStore.get()).toBe(first);
  });
});
