import { describe, expect, it } from 'vitest';
import { baseSplitNames, namedFailures } from './base-split.js';

describe('namedFailures', () => {
  it('names the first three failures and counts the rest as one last entry', () => {
    expect(namedFailures(['a', 'b', 'c', 'd', 'e'], 5)).toEqual(['a', 'b', 'c', '+2 more']);
    expect(namedFailures(['a'], 1)).toEqual(['a']);
  });

  it('counts the failures an event left unnamed', () => {
    expect(namedFailures(['a', 'b', 'c'], 7)).toEqual(['a', 'b', 'c', '+4 more']);
  });
});

describe('baseSplitNames', () => {
  it('lists the new side before the pre-existing side and leaves out a side with no name', () => {
    expect(
      baseSplitNames({
        newFailures: 1,
        preExisting: 2,
        newKeys: ['src/ledger.test.ts'],
        preExistingKeys: ['a > one', 'a > two'],
      }),
    ).toEqual([
      { side: 'new', names: ['src/ledger.test.ts'] },
      { side: 'pre-existing', names: ['a > one', 'a > two'] },
    ]);
    expect(baseSplitNames({ newFailures: 0, preExisting: 1, preExistingKeys: ['a'] })).toEqual([
      { side: 'pre-existing', names: ['a'] },
    ]);
    expect(baseSplitNames({ newFailures: 2, preExisting: 0 })).toEqual([]);
  });
});
