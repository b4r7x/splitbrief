import { describe, expect, it } from 'vitest';
import { FULL_LOGO, SMALL_LOGO, getLogoTier, getLogoHeight } from './logo.js';

describe('getLogoTier', () => {
  it('returns full when rows >= 24 and cols >= 44', () => {
    expect(getLogoTier(24, 44)).toBe('full');
  });

  it('returns small when rows >= 24 but cols < 44', () => {
    expect(getLogoTier(24, 43)).toBe('small');
  });

  it('returns small when rows = 23 (just under full threshold)', () => {
    expect(getLogoTier(23, 120)).toBe('small');
  });

  it('returns small at rows = 18', () => {
    expect(getLogoTier(18, 80)).toBe('small');
  });

  it('returns plain when rows < 18', () => {
    expect(getLogoTier(17, 80)).toBe('plain');
  });

  it('returns plain at very small terminal', () => {
    expect(getLogoTier(10, 30)).toBe('plain');
  });
});

describe('getLogoHeight', () => {
  it('returns 6 for full tier', () => {
    expect(getLogoHeight('full')).toBe(6);
  });

  it('returns 1 for small tier', () => {
    expect(getLogoHeight('small')).toBe(1);
  });

  it('returns 1 for plain tier', () => {
    expect(getLogoHeight('plain')).toBe(1);
  });
});

describe('FULL_LOGO', () => {
  it('has 6 lines', () => {
    expect(FULL_LOGO.split('\n')).toHaveLength(6);
  });

  it('has no line wider than 72 chars', () => {
    for (const line of FULL_LOGO.split('\n')) {
      expect(line.length).toBeLessThanOrEqual(72);
    }
  });
});

describe('SMALL_LOGO', () => {
  it('contains diptych', () => {
    expect(SMALL_LOGO).toContain('diptych');
  });
});
