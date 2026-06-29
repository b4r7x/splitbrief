import { describe, expect, it } from 'vitest';
import { formatCacheHitPct } from './cost-chrome.js';

describe('formatCacheHitPct', () => {
  it.each([
    [undefined, 1000, 'cache n/a'],
    [0, 0, 'cache n/a'],
    [0, 1000, 'cache n/a'],
    [500, 0, 'cache 100%'],
    [1, 2, 'cache 33%'],
    [500, 500, 'cache 50%'],
  ] as const)('formats cache read %s with input %i as %s', (cacheRead, input, expected) => {
    expect(formatCacheHitPct(cacheRead, input)).toBe(expected);
  });
});
