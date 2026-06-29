import { describe, expect, it } from 'vitest';
import { hoverStore } from '../../src/stores/ui/hover.js';
import { resetAllStores } from './stores.js';

describe('resetAllStores', () => {
  it('resets the hover store', () => {
    hoverStore.set('brief', 3);
    resetAllStores();
    expect(hoverStore.get()).toBeNull();
  });
});
