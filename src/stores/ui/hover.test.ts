import { beforeEach, describe, expect, it } from 'vitest';
import { hoverStore } from './hover.js';

describe('hoverStore', () => {
  beforeEach(() => {
    hoverStore.reset();
  });

  it('sets the hovered conversation row index', () => {
    hoverStore.set(2);
    expect(hoverStore.get()).toBe(2);
  });

  it('clears to null', () => {
    expect(hoverStore.get()).toBeNull();
    hoverStore.set(0);
    hoverStore.clear();
    expect(hoverStore.get()).toBeNull();
  });
});
