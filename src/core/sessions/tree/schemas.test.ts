import { describe, expect, it } from 'vitest';
import { entryId, nextEntryId } from './schemas.js';

describe('nextEntryId', () => {
  it('generates padded ids from the current entry count', () => {
    expect(nextEntryId(0)).toBe(entryId('E0001'));
    expect(nextEntryId(1)).toBe(entryId('E0002'));
    expect(nextEntryId(9)).toBe(entryId('E0010'));
    expect(nextEntryId(99)).toBe(entryId('E0100'));
    expect(nextEntryId(999)).toBe(entryId('E1000'));
  });
});
