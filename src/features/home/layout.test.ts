import { describe, expect, it } from 'vitest';
import { getHomeLayout } from './layout.js';

describe('getHomeLayout', () => {
  it('centers a capped body inside a wider dock on tall terminals', () => {
    expect(getHomeLayout({ cols: 160, rows: 42, isSmall: false })).toEqual({
      inputWidth: 92,
      bodyWidth: 72,
      showBanner: true,
      mainJustifyContent: 'center',
      inputBottomMargin: 2,
      recentSessionLimit: 8,
      recentFeatureColWidth: 60,
    });
  });

  it('keeps medium terminals centered with a smaller recent-session cap', () => {
    expect(getHomeLayout({ cols: 100, rows: 32, isSmall: true })).toMatchObject({
      inputWidth: 70,
      bodyWidth: 70,
      showBanner: true,
      mainJustifyContent: 'center',
      inputBottomMargin: 1,
      recentSessionLimit: 5,
    });
  });

  it('keeps short terminals useful while still prioritizing the input dock', () => {
    expect(getHomeLayout({ cols: 80, rows: 20, isSmall: true })).toMatchObject({
      inputWidth: 70,
      bodyWidth: 70,
      showBanner: true,
      mainJustifyContent: 'center',
      inputBottomMargin: 0,
      recentSessionLimit: 3,
    });
  });

  it('uses compact top alignment and hides recent sessions below 18 rows', () => {
    expect(getHomeLayout({ cols: 80, rows: 17, isSmall: true })).toMatchObject({
      showBanner: false,
      mainJustifyContent: 'flex-start',
      recentSessionLimit: 0,
    });
  });

  it('keeps recent-session text width inside the body on narrow terminals', () => {
    const layout = getHomeLayout({ cols: 10, rows: 24, isSmall: false });
    expect(layout.recentFeatureColWidth).toBeLessThanOrEqual(layout.bodyWidth);
  });
});
