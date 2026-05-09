import { describe, it, expect } from 'vitest';
import { normalizeLegacyMode } from './enums.js';

describe('normalizeLegacyMode', () => {
  it.each([
    ['instant', 'instant'],
    ['quick', 'quick'],
    ['standard', 'standard'],
    ['speckit', 'speckit'],
    ['full', 'speckit'],
  ])('normalizes "%s" → "%s"', (input, expected) => {
    expect(normalizeLegacyMode(input)).toBe(expected);
  });
  it('returns null for unknown values', () => {
    expect(normalizeLegacyMode('bogus')).toBeNull();
    expect(normalizeLegacyMode('')).toBeNull();
  });
});
