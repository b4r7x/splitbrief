import { beforeEach, describe, expect, it } from 'vitest';
import { commandPaletteMruStore, MAX_PALETTE_MRU } from './command-palette-mru.js';

describe('commandPaletteMruStore', () => {
  beforeEach(() => {
    commandPaletteMruStore.__testReset();
  });

  it('record single id', () => {
    commandPaletteMruStore.record('a');
    expect(commandPaletteMruStore.get().ids).toEqual(['a']);
  });

  it('most-recent first ordering', () => {
    commandPaletteMruStore.record('b');
    commandPaletteMruStore.record('a');
    expect(commandPaletteMruStore.get().ids).toEqual(['a', 'b']);
  });

  it('deduplicates on re-record', () => {
    commandPaletteMruStore.record('a');
    commandPaletteMruStore.record('a');
    commandPaletteMruStore.record('a');
    expect(commandPaletteMruStore.get().ids).toEqual(['a']);
  });

  it('caps at MAX_PALETTE_MRU', () => {
    for (let i = 0; i < MAX_PALETTE_MRU + 1; i++) {
      commandPaletteMruStore.record(`item-${i}`);
    }
    expect(commandPaletteMruStore.get().ids).toHaveLength(MAX_PALETTE_MRU);
  });

  it('getRank returns 1-based rank when id is first', () => {
    commandPaletteMruStore.record('a');
    expect(commandPaletteMruStore.getRank('a')).toBe(1);
  });

  it('getRank returns 0 when id is absent', () => {
    expect(commandPaletteMruStore.getRank('z')).toBe(0);
  });
});
