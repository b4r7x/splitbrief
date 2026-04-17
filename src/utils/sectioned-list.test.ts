import { describe, it, expect } from 'vitest';
import { toSectionedList } from './sectioned-list.js';

type Item = { name: string; section: string };

const key = (item: Item) => item.section;

describe('toSectionedList', () => {
  it('empty input returns empty output', () => {
    expect(toSectionedList([], key)).toEqual([]);
  });

  it('groups items by section key and emits header only when key changes', () => {
    const items: Item[] = [
      { name: 'a1', section: 'A' },
      { name: 'a2', section: 'A' },
      { name: 'b1', section: 'B' },
    ];
    expect(toSectionedList(items, key)).toEqual([
      { item: items[0], sectionHeader: 'A' },
      { item: items[1], sectionHeader: null },
      { item: items[2], sectionHeader: 'B' },
    ]);
  });
});
