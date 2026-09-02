import { describe, expect, it } from 'vitest';
import { formatContextLength, formatKnownCost, formatScoreSummary } from './formatting.js';

describe('formatScoreSummary', () => {
  it.each([
    [
      'orders errors before warnings',
      0.84,
      { errorCount: 2, warningCount: 3 },
      undefined,
      'score 0.84 · 2 errors · 3 warnings',
    ],
    [
      'omits a zero error count',
      0.9,
      { errorCount: 0, warningCount: 1 },
      undefined,
      'score 0.90 · 1 warning',
    ],
    [
      'omits a zero warning count',
      0.5,
      { errorCount: 1, warningCount: 0 },
      undefined,
      'score 0.50 · 1 error',
    ],
    ['omits both counts when zero', 1, { errorCount: 0, warningCount: 0 }, undefined, 'score 1.00'],
    [
      'uses the supplied label in place of "score"',
      0.95,
      { errorCount: 1, warningCount: 2 },
      'quality',
      'quality 0.95 · 1 error · 2 warnings',
    ],
  ] as const)('%s', (_label, score, counts, customLabel, expected) => {
    expect(formatScoreSummary(score, counts, customLabel)).toBe(expected);
  });
});

describe('formatKnownCost', () => {
  it('formats a fully-known cost as a plain dollar amount', () => {
    expect(formatKnownCost(12.5, 'known')).toBe('$12.50');
  });

  it('appends "+ unknown" to a partial cost with a positive amount', () => {
    expect(formatKnownCost(12.5, 'partial')).toBe('$12.50 + unknown');
  });

  it('reports "Unknown price" for a partial cost with no known amount', () => {
    expect(formatKnownCost(0, 'partial')).toBe('Unknown price');
  });
});

describe('formatContextLength', () => {
  it.each([
    [undefined, ''],
    [0, ''],
    [8_000, '8K'],
    [128_000, '128K'],
    [131_072, '131K'],
    [199_900, '199K'],
    [200_000, '200K'],
    [262_144, '262K'],
    [1_000_000, '1M'],
    [1_047_576, '1M'],
    [1_048_576, '1M'],
    [1_100_000, '1.1M'],
    [1_500_000, '1.5M'],
    [2_000_000, '2M'],
  ] as const)('floors %s to %s', (input, expected) => {
    expect(formatContextLength(input)).toBe(expected);
  });
});
