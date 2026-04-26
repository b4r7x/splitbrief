import { beforeEach, describe, expect, it } from 'vitest';
import { paletteMruStore, MAX_PALETTE_MRU } from './palette-mru.js';

describe('paletteMruStore', () => {
  beforeEach(() => {
    paletteMruStore.__testReset();
  });

  it('record single id', () => {
    paletteMruStore.record('a');
    expect(paletteMruStore.get().ids).toEqual(['a']);
  });

  it('most-recent first ordering', () => {
    paletteMruStore.record('b');
    paletteMruStore.record('a');
    expect(paletteMruStore.get().ids).toEqual(['a', 'b']);
  });

  it('deduplicates on re-record', () => {
    paletteMruStore.record('a');
    paletteMruStore.record('a');
    paletteMruStore.record('a');
    expect(paletteMruStore.get().ids).toEqual(['a']);
  });

  it('caps at MAX_PALETTE_MRU', () => {
    for (let i = 0; i < MAX_PALETTE_MRU + 1; i++) {
      paletteMruStore.record(`item-${i}`);
    }
    expect(paletteMruStore.get().ids).toHaveLength(MAX_PALETTE_MRU);
  });

  it('getRank returns 1-based rank when id is first', () => {
    paletteMruStore.record('a');
    expect(paletteMruStore.getRank('a')).toBe(1);
  });

  it('getRank returns 0 when id is absent', () => {
    expect(paletteMruStore.getRank('z')).toBe(0);
  });

  it('__testReset empties the list', () => {
    paletteMruStore.record('a');
    paletteMruStore.record('b');
    paletteMruStore.__testReset();
    expect(paletteMruStore.get().ids).toEqual([]);
  });

  it('use hook returns reactive updates', () => {
    let captured: string[] = [];
    const unsub = paletteMruStore.subscribe(() => {
      captured = paletteMruStore.get().ids;
    });
    paletteMruStore.record('x');
    unsub();
    expect(captured).toEqual(['x']);
  });
});
