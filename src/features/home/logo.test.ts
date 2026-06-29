import { describe, expect, it } from 'vitest';
import {
  getLogo,
  getLogoTier,
  getLogoHeight,
  FULL_LOGO,
  COMPACT_LOGO,
  LOGO_TAGLINE,
} from './logo.js';

describe('getLogoTier', () => {
  it('returns full when rows >= 24 and cols >= 44', () => {
    expect(getLogoTier(24, 44)).toBe('full');
  });

  it('returns compact when rows just under the full threshold', () => {
    expect(getLogoTier(23, 120)).toBe('compact');
  });

  it('returns compact when cols just under the full threshold', () => {
    expect(getLogoTier(24, 43)).toBe('compact');
  });

  it('returns compact at a very small terminal', () => {
    expect(getLogoTier(10, 30)).toBe('compact');
  });

  it('returns full comfortably above the (24,44) corner', () => {
    expect(getLogoTier(40, 120)).toBe('full');
  });

  it('returns compact when cols alone are sub-44 on a tall terminal', () => {
    expect(getLogoTier(60, 43)).toBe('compact');
  });
});

describe('getLogo', () => {
  it('renders multi-line ASCII art for the full tier', () => {
    const logo = getLogo('full');
    expect(logo).toContain('__| (_)');
    expect(logo.split('\n').length).toBeGreaterThan(1);
  });

  it('renders multi-line ASCII art for the compact tier', () => {
    const logo = getLogo('compact');
    expect(logo).toContain('__|_||_|');
    expect(logo.split('\n').length).toBeGreaterThan(1);
  });

  it('renders the compact tier as art, not the bare word or a divider', () => {
    const logo = getLogo('compact');
    expect(logo).not.toBe('diptych');
    expect(logo.includes('──')).toBe(false);
  });

  it('renders the full tier as real art, not the bare word or a divider', () => {
    const logo = getLogo('full');
    expect(logo).not.toBe('diptych');
    expect(logo.includes('──')).toBe(false);
    expect(logo.split('\n').length).toBeGreaterThan(1);
  });

  it('trims trailing whitespace on every line and has no trailing blank line for both tiers', () => {
    for (const tier of ['full', 'compact'] as const) {
      const lines = getLogo(tier).split('\n');
      expect(lines.every((l) => l === l.replace(/\s+$/, ''))).toBe(true);
      expect(lines.at(-1)).not.toBe('');
    }
  });
});

describe('FULL_LOGO and COMPACT_LOGO constants', () => {
  it('match what getLogo returns for each tier', () => {
    expect(FULL_LOGO).toBe(getLogo('full'));
    expect(COMPACT_LOGO).toBe(getLogo('compact'));
  });

  it('are distinct between tiers and getLogo is an idempotent lookup', () => {
    expect(getLogo('full')).not.toBe(getLogo('compact'));
    expect(getLogo('full')).toBe(getLogo('full'));
    expect(getLogo('compact')).toBe(getLogo('compact'));
    expect(getLogo('full')).not.toBe('');
    expect(getLogo('compact')).not.toBe('');
  });
});

describe('LOGO_TAGLINE', () => {
  it('is the single dim hero tagline, on one line, middot-joined', () => {
    expect(LOGO_TAGLINE).toBe('plan expensively · build cheaply');
    expect(LOGO_TAGLINE).not.toContain('\n');
  });
});

describe('getLogoHeight', () => {
  it('keeps the compact logo shorter than the full logo', () => {
    expect(getLogoHeight('compact')).toBeLessThan(getLogoHeight('full'));
  });

  it('keeps the full logo at least 5 lines tall', () => {
    expect(getLogoHeight('full')).toBeGreaterThanOrEqual(5);
  });

  it('keeps the compact logo genuinely multi-line (height floor >= 2)', () => {
    expect(getLogoHeight('compact')).toBeGreaterThanOrEqual(2);
  });
});
