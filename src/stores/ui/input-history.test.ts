import { beforeEach, describe, expect, it } from 'vitest';
import { inputHistoryStore, MAX_INPUT_HISTORY } from './input-history.js';

describe('inputHistoryStore', () => {
  beforeEach(() => {
    inputHistoryStore.reset();
  });

  it('ignores empty values', () => {
    inputHistoryStore.push('   ');

    expect(inputHistoryStore.get().entries).toEqual([]);
  });

  it('stores trimmed values with the newest first', () => {
    inputHistoryStore.push('first');
    inputHistoryStore.push(' second ');

    expect(inputHistoryStore.get().entries).toEqual(['second', 'first']);
  });

  it('deduplicates entries by moving repeats to the front', () => {
    inputHistoryStore.push('first');
    inputHistoryStore.push('second');
    inputHistoryStore.push('first');

    expect(inputHistoryStore.get().entries).toEqual(['first', 'second']);
  });

  it('skips consecutive duplicates', () => {
    inputHistoryStore.push('first');
    inputHistoryStore.push('first');

    expect(inputHistoryStore.get().entries).toEqual(['first']);
  });

  it('caps history length', () => {
    for (let index = 0; index < MAX_INPUT_HISTORY + 2; index++) {
      inputHistoryStore.push(`item-${index}`);
    }

    expect(inputHistoryStore.get().entries).toHaveLength(MAX_INPUT_HISTORY);
    expect(inputHistoryStore.get().entries[0]).toBe('item-11');
  });

  describe('hydrate', () => {
    it('replaces state with provided entries', () => {
      inputHistoryStore.push('stale');
      inputHistoryStore.hydrate(['fresh-a', 'fresh-b']);

      expect(inputHistoryStore.get().entries).toEqual(['fresh-a', 'fresh-b']);
    });

    it('deduplicates on hydrate', () => {
      inputHistoryStore.hydrate(['a', 'b', 'a', 'c']);

      expect(inputHistoryStore.get().entries).toEqual(['a', 'b', 'c']);
    });

    it('caps hydrated entries at MAX_INPUT_HISTORY', () => {
      const lines = Array.from({ length: MAX_INPUT_HISTORY + 3 }, (_, i) => `item-${i}`);
      inputHistoryStore.hydrate(lines);

      expect(inputHistoryStore.get().entries).toHaveLength(MAX_INPUT_HISTORY);
    });

    it('ignores blank entries on hydrate', () => {
      inputHistoryStore.hydrate(['first', '', '   ', 'second']);

      expect(inputHistoryStore.get().entries).toEqual(['first', 'second']);
    });

    it('resets to empty on hydrate with empty array', () => {
      inputHistoryStore.push('something');
      inputHistoryStore.hydrate([]);

      expect(inputHistoryStore.get().entries).toEqual([]);
    });
  });
});
