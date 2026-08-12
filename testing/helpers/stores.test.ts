import { describe, expect, it } from 'vitest';
import { hoverStore } from '../../src/stores/ui/hover.js';
import { reviewKeysStore } from '../../src/stores/ui/review-keys.js';
import { resetAllStores } from './stores.js';

describe('resetAllStores', () => {
  it('resets the hover store', () => {
    hoverStore.set('brief', 3);
    resetAllStores();
    expect(hoverStore.get()).toBeNull();
  });

  it('resets review-key arming', () => {
    reviewKeysStore.setArmed(true);
    resetAllStores();
    expect(reviewKeysStore.get().armed).toBe(false);
  });
});
