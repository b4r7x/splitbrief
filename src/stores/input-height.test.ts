import { beforeEach, describe, expect, it } from 'vitest';
import { inputHeightStore } from './input-height.js';

describe('inputHeightStore', () => {
  beforeEach(() => {
    inputHeightStore.reset();
  });

  it('initialises with rows=3', () => {
    expect(inputHeightStore.get().rows).toBe(3);
  });

  describe('setRows', () => {
    it('updates rows', () => {
      inputHeightStore.setRows(5);
      expect(inputHeightStore.get().rows).toBe(5);
    });

    it('short-circuits on repeated same value (object identity preserved)', () => {
      inputHeightStore.setRows(5);
      const snapshot = inputHeightStore.get();
      inputHeightStore.setRows(5);
      expect(inputHeightStore.get()).toBe(snapshot);
    });

    it('normalizes invalid values to a minimum whole row', () => {
      inputHeightStore.setRows(Number.NaN);
      expect(inputHeightStore.get().rows).toBe(1);

      inputHeightStore.setRows(4.8);
      expect(inputHeightStore.get().rows).toBe(4);

      inputHeightStore.setRows(-3);
      expect(inputHeightStore.get().rows).toBe(1);
    });
  });

  describe('reset', () => {
    it('resets to initial state', () => {
      inputHeightStore.setRows(6);
      inputHeightStore.reset();
      expect(inputHeightStore.get().rows).toBe(3);
    });
  });
});
