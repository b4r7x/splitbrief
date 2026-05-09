import { beforeEach, describe, expect, it } from 'vitest';
import { commandPaletteMruStore, MAX_PALETTE_MRU } from './command-palette-mru.js';

describe('commandPaletteMruStore', () => {
  beforeEach(() => {
    commandPaletteMruStore.reset();
  });

  it('keeps commands ordered by recent use and reports their ranks', () => {
    commandPaletteMruStore.record('b');
    commandPaletteMruStore.record('a');
    commandPaletteMruStore.record('a');
    commandPaletteMruStore.record('c');

    expect(commandPaletteMruStore.get().ids).toEqual(['c', 'a', 'b']);
    expect(commandPaletteMruStore.getRank('c')).toBe(1);
    expect(commandPaletteMruStore.getRank('a')).toBe(2);
    expect(commandPaletteMruStore.getRank('b')).toBe(3);
    expect(commandPaletteMruStore.getRank('z')).toBe(0);
  });

  it('drops the oldest command when the MRU list exceeds capacity', () => {
    for (let i = 0; i < MAX_PALETTE_MRU + 1; i++) {
      commandPaletteMruStore.record(`item-${i}`);
    }

    expect(commandPaletteMruStore.get().ids).toHaveLength(MAX_PALETTE_MRU);
    expect(commandPaletteMruStore.get().ids[0]).toBe(`item-${MAX_PALETTE_MRU}`);
    expect(commandPaletteMruStore.get().ids).not.toContain('item-0');
    expect(commandPaletteMruStore.getRank('item-0')).toBe(0);
  });
});
