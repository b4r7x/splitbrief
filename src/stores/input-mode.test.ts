import { beforeEach, describe, expect, it } from 'vitest';
import { inputModeStore } from './input-mode.js';

describe('inputModeStore', () => {
  beforeEach(() => {
    inputModeStore.reset();
  });

  describe('setInteractive', () => {
    it('sets interactive to true', () => {
      expect(inputModeStore.get().interactive).toBe(false);
      inputModeStore.setInteractive(true);
      expect(inputModeStore.get().interactive).toBe(true);
    });

    it('sets interactive to false', () => {
      inputModeStore.setInteractive(true);
      inputModeStore.setInteractive(false);
      expect(inputModeStore.get().interactive).toBe(false);
    });

    it('short-circuits when value is unchanged', () => {
      const before = inputModeStore.get();
      inputModeStore.setInteractive(false);
      expect(inputModeStore.get()).toBe(before);
    });
  });

  describe('reset', () => {
    it('resets to initial state', () => {
      inputModeStore.setInteractive(true);
      inputModeStore.reset();
      expect(inputModeStore.get().interactive).toBe(false);
    });
  });
});
