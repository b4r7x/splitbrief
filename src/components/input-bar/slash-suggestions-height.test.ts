import { describe, expect, it } from 'vitest';
import { computeSuggestionsCap } from './slash-suggestions-height.js';

describe('computeSuggestionsCap', () => {
  it('caps at 8 for a standard 24-row terminal', () => {
    expect(computeSuggestionsCap(24, 1)).toBe(8);
  });

  it('caps at 8 for a large terminal', () => {
    expect(computeSuggestionsCap(50, 1)).toBe(8);
  });

  it('floors at 3 for a tiny terminal', () => {
    expect(computeSuggestionsCap(10, 1)).toBe(3);
  });

  it('shrinks below hard cap on medium terminals with multi-line input', () => {
    expect(computeSuggestionsCap(18, 4)).toBe(3);
  });

  it('returns different caps as terminal rows change (resize)', () => {
    const tiny = computeSuggestionsCap(14, 1);
    const standard = computeSuggestionsCap(24, 1);
    expect(standard).toBeGreaterThanOrEqual(tiny);
  });
});
