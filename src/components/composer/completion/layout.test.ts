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
});

describe('computeCompletionOverlayRows', () => {
  it('matches the true panel height: visible rows capped at maxVisible plus chrome', () => {
    expect(
      computeCompletionOverlayRows({
        itemCount: 12,
        maxVisible: 8,
      }),
    ).toBe(12);
  });

  it('stays closed when there is nothing to show', () => {
    expect(computeCompletionOverlayRows({ itemCount: 0, maxVisible: 8 })).toBe(0);
  });

  it('uses one content row for a fuzzy-only command suggestion', () => {
    expect(
      computeCompletionOverlayRows({
        itemCount: 0,
        maxVisible: 8,
        hasFuzzyMatch: true,
      }),
    ).toBe(5);
  });

  it('uses one content row for an empty "no matching commands" message', () => {
    expect(
      computeCompletionOverlayRows({
        itemCount: 0,
        maxVisible: 8,
        hasEmptyMessage: true,
      }),
    ).toBe(5);
  });
});
