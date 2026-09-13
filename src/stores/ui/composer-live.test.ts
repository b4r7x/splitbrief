import { beforeEach, describe, expect, it } from 'vitest';
import { composerLiveStore } from './composer-live.js';

describe('composerLiveStore', () => {
  beforeEach(() => {
    composerLiveStore.reset();
  });

  it('starts empty and follows the composer draft', () => {
    expect(composerLiveStore.get().empty).toBe(true);
    composerLiveStore.setEmpty(false);
    expect(composerLiveStore.get().empty).toBe(false);
  });

  it('keeps the same snapshot when the emptiness does not change', () => {
    composerLiveStore.setEmpty(false);
    const first = composerLiveStore.get();
    composerLiveStore.setEmpty(false);
    expect(composerLiveStore.get()).toBe(first);
  });
});
