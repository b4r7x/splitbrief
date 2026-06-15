import { describe, expect, it } from 'vitest';
import { formatKnownCost, formatScoreSummary } from './formatting.js';

describe('formatScoreSummary', () => {
  it('orders errors before warnings', () => {
    expect(formatScoreSummary(0.84, { errorCount: 2, warningCount: 3 })).toBe(
      'score 0.84 · 2 errors · 3 warnings',
    );
  });

  it('omits a zero error count', () => {
    expect(formatScoreSummary(0.9, { errorCount: 0, warningCount: 1 })).toBe(
      'score 0.90 · 1 warning',
    );
  });

  it('omits a zero warning count', () => {
    expect(formatScoreSummary(0.5, { errorCount: 1, warningCount: 0 })).toBe(
      'score 0.50 · 1 error',
    );
  });

  it('omits both counts when zero', () => {
    expect(formatScoreSummary(1, { errorCount: 0, warningCount: 0 })).toBe('score 1.00');
  });

  it('uses the supplied label in place of "score"', () => {
    expect(formatScoreSummary(0.95, { errorCount: 1, warningCount: 2 }, 'quality')).toBe(
      'quality 0.95 · 1 error · 2 warnings',
    );
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
