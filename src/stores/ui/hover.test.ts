import { beforeEach, describe, expect, it } from 'vitest';
import { hoverStore } from './hover.js';

describe('hoverStore', () => {
  beforeEach(() => {
    hoverStore.reset();
  });

  it('starts null', () => {
    expect(hoverStore.get()).toBeNull();
  });

  it('sets a surface and index', () => {
    hoverStore.set('brief', 2);
    expect(hoverStore.get()).toEqual({ surface: 'brief', index: 2 });
  });

  it('keeps the same snapshot when set to the same value', () => {
    hoverStore.set('conversation', 1);
    const first = hoverStore.get();
    hoverStore.set('conversation', 1);
    expect(hoverStore.get()).toBe(first);
  });

  it('clears to null', () => {
    hoverStore.set('brief', 0);
    hoverStore.clear();
    expect(hoverStore.get()).toBeNull();
  });
});
