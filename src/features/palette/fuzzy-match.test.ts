import { describe, expect, it } from 'vitest';
import { fuzzyMatch, fuzzyMatchExtended } from './fuzzy-match.js';

describe('fuzzyMatch', () => {
  it('empty query returns { score: 0, positions: [] } (not null)', () => {
    const result = fuzzyMatch('', 'anything');
    expect(result).not.toBeNull();
    expect(result?.score).toBe(0);
    expect(result?.positions).toEqual([]);
  });

  it('full exact match returns score > 0', () => {
    const result = fuzzyMatch('revise', 'revise');
    expect(result).not.toBeNull();
    expect(result?.score).toBeGreaterThan(0);
  });

  it('non-matching query returns null', () => {
    expect(fuzzyMatch('xyz', 'revise-spec')).toBeNull();
  });

  it("'rs' matches 'revise-spec' as a subsequence", () => {
    const result = fuzzyMatch('rs', 'revise-spec');
    expect(result).not.toBeNull();
    expect(result?.positions.length).toBeGreaterThan(0);
  });

  it('score is clamped to [0, 1]', () => {
    const result = fuzzyMatch('rv', 'revise-spec');
    expect(result).not.toBeNull();
    expect(result?.score).toBeGreaterThanOrEqual(0);
    expect(result?.score).toBeLessThanOrEqual(1);
  });

  it('case-insensitive matching', () => {
    expect(fuzzyMatch('REV', 'revise')).not.toBeNull();
  });

  it('single-char query against single-char matching target', () => {
    const result = fuzzyMatch('a', 'a');
    expect(result).not.toBeNull();
    expect(Number.isFinite(result?.score)).toBe(true);
    expect(Number.isNaN(result?.score)).toBe(false);
    expect(result?.score).toBeGreaterThan(0);
  });

  it("fuzzyMatch('rv', 'revise-spec') matches with expected positions", () => {
    const result = fuzzyMatch('rv', 'revise-spec');
    expect(result).not.toBeNull();
    expect(result?.positions).toEqual([0, 2]);
  });
});

describe('fuzzyMatchExtended', () => {
  it("fuzzyMatchExtended('rev rev', 'revise-spec') scores and deduplicates positions", () => {
    const result = fuzzyMatchExtended('rev rev', 'revise-spec');
    expect(result).not.toBeNull();
    expect(result?.score).toBeGreaterThan(1);
    expect(result?.positions).toEqual([0, 1, 2]);
  });

  it("fuzzyMatchExtended('rev xyz', 'revise-spec') returns null", () => {
    expect(fuzzyMatchExtended('rev xyz', 'revise-spec')).toBeNull();
  });

  it("fuzzyMatchExtended('', 'anything') returns { score: 0, positions: [] }", () => {
    const result = fuzzyMatchExtended('', 'anything');
    expect(result).not.toBeNull();
    expect(result?.score).toBe(0);
    expect(result?.positions).toEqual([]);
  });
});
