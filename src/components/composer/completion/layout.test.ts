import { describe, expect, it } from 'vitest';
import { computeCompletionOverlayRows, computeCompletionCap } from './layout.js';

describe('computeCompletionCap', () => {
  it('caps at 8 for a standard 24-row terminal', () => {
    expect(computeCompletionCap(24, 1)).toBe(8);
  });

  it('caps at 8 for a large terminal', () => {
    expect(computeCompletionCap(50, 1)).toBe(8);
  });

  it('floors at 3 for a tiny terminal', () => {
    expect(computeCompletionCap(10, 1)).toBe(3);
  });

  it('shrinks below hard cap on medium terminals with multi-line input', () => {
    expect(computeCompletionCap(18, 4)).toBe(3);
  });

  it('returns different caps as terminal rows change', () => {
    const tiny = computeCompletionCap(14, 1);
    const standard = computeCompletionCap(24, 1);
    expect(standard).toBeGreaterThanOrEqual(tiny);
  });
});

describe('computeCompletionOverlayRows', () => {
  it('includes panel chrome and scroll indicators for visible suggestion rows', () => {
    expect(computeCompletionOverlayRows({
      itemCount: 12,
      selectedIndex: 10,
      maxVisible: 8,
    })).toBe(13);
  });

  it('uses one content row for a fuzzy-only command suggestion', () => {
    expect(computeCompletionOverlayRows({
      itemCount: 0,
      selectedIndex: 0,
      maxVisible: 8,
      hasFuzzyMatch: true,
    })).toBe(5);
  });
});
