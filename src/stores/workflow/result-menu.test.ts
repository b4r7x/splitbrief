import { expect, it } from 'vitest';
import { resetAllStores } from '#testing/helpers/stores.js';
import { resultMenuStore } from './result-menu.js';

it('clears result menu measurements with the other stores between fixtures', () => {
  resultMenuStore.setHeight(7);
  resetAllStores();
  expect(resultMenuStore.get()).toBeNull();
});
