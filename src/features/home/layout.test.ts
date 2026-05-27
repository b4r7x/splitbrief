import { describe, expect, it } from 'vitest';
import { getHomeLayout } from './layout.js';

describe('getHomeLayout', () => {
  it('centers a capped body inside a wider dock on tall terminals', () => {
    expect(getHomeLayout({ cols: 160, rows: 42, isSmall: false })).toEqual({
      inputWidth: 92,
      bodyWidth: 72,
      logoTier: 'full',
      inputBottomMargin: 2,
      recentSessionLimit: 12,
      recentFeatureColWidth: 60,
    });
  });

  it('keeps medium terminals with full logo and content-aware session limit', () => {
    expect(getHomeLayout({ cols: 100, rows: 32, isSmall: true })).toMatchObject({
      inputWidth: 70,
      bodyWidth: 70,
      logoTier: 'full',
      inputBottomMargin: 1,
      recentSessionLimit: 12,
    });
  });

  it('uses small logo on shorter terminals with scaled session limit', () => {
    expect(getHomeLayout({ cols: 80, rows: 20, isSmall: true })).toMatchObject({
      inputWidth: 70,
      bodyWidth: 70,
      logoTier: 'small',
      inputBottomMargin: 0,
      recentSessionLimit: 10,
    });
  });

  it('hides recent sessions below 18 rows', () => {
    expect(getHomeLayout({ cols: 80, rows: 17, isSmall: true })).toMatchObject({
      logoTier: 'plain',
      recentSessionLimit: 0,
    });
  });

  it('keeps recent-session text width inside the body on narrow terminals', () => {
    const layout = getHomeLayout({ cols: 10, rows: 24, isSmall: false });
    expect(layout.recentFeatureColWidth).toBeLessThanOrEqual(layout.bodyWidth);
  });

  it('computes content-aware limit based on available rows', () => {
    const tall = getHomeLayout({ cols: 120, rows: 60, isSmall: false });
    expect(tall.recentSessionLimit).toBe(12);

    const medium = getHomeLayout({ cols: 120, rows: 30, isSmall: false });
    expect(medium.recentSessionLimit).toBeGreaterThan(0);
    expect(medium.recentSessionLimit).toBeLessThanOrEqual(12);
  });

  it('returns small logo when cols < 44 even with tall terminal', () => {
    const layout = getHomeLayout({ cols: 40, rows: 30, isSmall: false });
    expect(layout.logoTier).toBe('small');
  });
});
