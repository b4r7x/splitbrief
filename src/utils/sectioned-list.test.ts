import { describe, it, expect } from 'vitest';
import { toSectionedList } from './sectioned-list.js';

type Item = { name: string; section: string };

const key = (item: Item) => item.section;

describe('toSectionedList', () => {
  it('empty input returns empty output', () => {
    expect(toSectionedList([], key)).toEqual([]);
  });

  it('single item has sectionHeader equal to its key', () => {
    const items: Item[] = [{ name: 'a', section: 'A' }];
    expect(toSectionedList(items, key)).toEqual([
      { item: items[0], sectionHeader: 'A' },
    ]);
  });

  it('two items in same section: second has sectionHeader null', () => {
    const items: Item[] = [
      { name: 'a', section: 'A' },
      { name: 'b', section: 'A' },
    ];
    expect(toSectionedList(items, key)).toEqual([
      { item: items[0], sectionHeader: 'A' },
      { item: items[1], sectionHeader: null },
    ]);
  });

  it('two items in different sections: both have sectionHeader set', () => {
    const items: Item[] = [
      { name: 'a', section: 'A' },
      { name: 'b', section: 'B' },
    ];
    expect(toSectionedList(items, key)).toEqual([
      { item: items[0], sectionHeader: 'A' },
      { item: items[1], sectionHeader: 'B' },
    ]);
  });

  it('three items (a, a, b): [header A, null, header B]', () => {
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
