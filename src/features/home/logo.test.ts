import { describe, expect, it } from 'vitest';
import { getLogo, getLogoTier, getLogoHeight } from './logo.js';

describe('getLogoTier', () => {
  it.each([
    { rows: 24, cols: 51, tier: 'full' as const },
    { rows: 23, cols: 120, tier: 'compact' as const },
    { rows: 24, cols: 50, tier: 'compact' as const },
    { rows: 10, cols: 30, tier: 'compact' as const },
    { rows: 40, cols: 120, tier: 'full' as const },
    { rows: 60, cols: 50, tier: 'compact' as const },
  ])('returns $tier when rows=$rows and cols=$cols', ({ rows, cols, tier }) => {
    expect(getLogoTier(rows, cols)).toBe(tier);
  });
});

describe('getLogo', () => {
  it.each([
    { tier: 'full' as const, marker: '|____/| .__/' },
    { tier: 'compact' as const, marker: '|___/ .__/' },
  ])('tier $tier is multiline art with clean line endings', ({ tier, marker }) => {
    const logo = getLogo(tier);
    const lines = logo.split('\n');

    expect(logo).toContain(marker);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.every((line) => line === line.replace(/\s+$/, ''))).toBe(true);
    expect(lines.at(-1)).not.toBe('');
    expect(getLogoHeight(tier)).toBe(lines.length);
    expect(logo.includes('──')).toBe(false);
  });

  it('keeps tiers distinct with compact shorter than full', () => {
    expect(getLogo('full')).not.toBe(getLogo('compact'));
    expect(getLogoHeight('compact')).toBeLessThan(getLogoHeight('full'));
  });
});
