import { beforeEach, describe, expect, it } from 'vitest';
import { inputHistoryStore, MAX_INPUT_HISTORY } from './input-history.js';

describe('inputHistoryStore', () => {
  beforeEach(() => {
    inputHistoryStore.reset();
  });

  it('covers push/dedup/caps/hydrate end-to-end', () => {
    // push ignores empty / whitespace-only values.
    inputHistoryStore.push('   ');
    expect(inputHistoryStore.get().entries).toEqual([]);

    // push trims and stores newest-first.
    inputHistoryStore.push('first');
    inputHistoryStore.push(' second ');
    expect(inputHistoryStore.get().entries).toEqual(['second', 'first']);

    // pushing an existing value moves it to the front (dedup by re-push).
    inputHistoryStore.push('first');
    expect(inputHistoryStore.get().entries).toEqual(['first', 'second']);

    // consecutive duplicates are no-ops.
    inputHistoryStore.push('first');
    expect(inputHistoryStore.get().entries).toEqual(['first', 'second']);

    // history is capped at MAX_INPUT_HISTORY (newest kept).
    inputHistoryStore.reset();
    for (let index = 0; index < MAX_INPUT_HISTORY + 2; index++) {
      inputHistoryStore.push(`item-${index}`);
    }
    expect(inputHistoryStore.get().entries).toHaveLength(MAX_INPUT_HISTORY);
    expect(inputHistoryStore.get().entries[0]).toBe(`item-${MAX_INPUT_HISTORY + 1}`);

    // hydrate replaces state entirely with the provided entries.
    inputHistoryStore.hydrate(['fresh-a', 'fresh-b']);
    expect(inputHistoryStore.get().entries).toEqual(['fresh-a', 'fresh-b']);

    // hydrate deduplicates.
    inputHistoryStore.hydrate(['a', 'b', 'a', 'c']);
    expect(inputHistoryStore.get().entries).toEqual(['a', 'b', 'c']);

    // hydrate ignores blank entries.
    inputHistoryStore.hydrate(['first', '', '   ', 'second']);
    expect(inputHistoryStore.get().entries).toEqual(['first', 'second']);

    // hydrate caps at MAX_INPUT_HISTORY.
    const lines = Array.from({ length: MAX_INPUT_HISTORY + 3 }, (_, i) => `item-${i}`);
    inputHistoryStore.hydrate(lines);
    expect(inputHistoryStore.get().entries).toHaveLength(MAX_INPUT_HISTORY);

    // hydrate([]) resets to empty.
    inputHistoryStore.push('something');
    inputHistoryStore.hydrate([]);
    expect(inputHistoryStore.get().entries).toEqual([]);
  });
});
