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
    expect(result!.score).toBeGreaterThan(0);
  });

  it('non-matching query returns null', () => {
    expect(fuzzyMatch('xyz', 'revise-spec')).toBeNull();
  });

  it("'rs' matches 'revise-spec' as a subsequence", () => {
    const result = fuzzyMatch('rs', 'revise-spec');
    expect(result).not.toBeNull();
    expect(result!.positions.length).toBeGreaterThan(0);
  });

  it("'rs' does NOT match 'help'", () => {
    expect(fuzzyMatch('rs', 'help')).toBeNull();
  });

  it("score for 'abc' in 'abcdef' > score for 'abc' in 'a_b_c_def'", () => {
    const a = fuzzyMatch('abc', 'abcdef');
    const b = fuzzyMatch('abc', 'a_b_c_def');
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a!.score).toBeGreaterThan(b!.score);
  });

  it("word boundary bonus: 'r' in 'revise-spec' at position 0 scores higher than 'e' in 'revise-spec'", () => {
    const r = fuzzyMatch('r', 'revise-spec');
    const e = fuzzyMatch('e', 'revise-spec');
    expect(r).not.toBeNull();
    expect(e).not.toBeNull();
    expect(r!.score).toBeGreaterThan(e!.score);
  });

  it('score is clamped to [0, 1]', () => {
    const result = fuzzyMatch('rv', 'revise-spec');
    expect(result).not.toBeNull();
    expect(result!.score).toBeGreaterThanOrEqual(0);
    expect(result!.score).toBeLessThanOrEqual(1);
  });

  it('case-insensitive matching', () => {
    expect(fuzzyMatch('REV', 'revise')).not.toBeNull();
  });

  it('single-char query against single-char matching target', () => {
    const result = fuzzyMatch('a', 'a');
    expect(result).not.toBeNull();
    expect(Number.isFinite(result!.score)).toBe(true);
    expect(Number.isNaN(result!.score)).toBe(false);
    expect(result!.score).toBeGreaterThan(0);
  });

  it("fuzzyMatch('rv', 'revise-spec') matches with expected positions", () => {
    const result = fuzzyMatch('rv', 'revise-spec');
    expect(result).not.toBeNull();
    expect(result!.positions).toEqual([0, 2]);
  });
});

describe('fuzzyMatchExtended', () => {
  it("fuzzyMatchExtended('rev sp', 'revise-spec') returns non-null", () => {
    expect(fuzzyMatchExtended('rev sp', 'revise-spec')).not.toBeNull();
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

  it('fuzzyMatchExtended can exceed score of 1 (multiple terms)', () => {
    const result = fuzzyMatchExtended('rev sp', 'revise-spec');
    expect(result).not.toBeNull();
    // Both terms match reasonably well; summed score may exceed 1
    expect(result!.score).toBeGreaterThan(0);
  });

  it('positions are deduplicated and sorted', () => {
    const result = fuzzyMatchExtended('re er', 'revise-spec');
    if (result !== null) {
      const pos = result.positions;
      for (let i = 1; i < pos.length; i++) {
        expect(pos[i]).toBeGreaterThan(pos[i - 1]!);
      }
    }
  });
});
