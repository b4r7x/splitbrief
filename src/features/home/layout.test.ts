import { describe, expect, it } from 'vitest';
import { getHomeLayout } from './layout.js';

describe('getHomeLayout', () => {
  it('sizes the dock and body to one wide overlay budget on tall terminals', () => {
    const layout = getHomeLayout({ cols: 160, rows: 42 });
    expect(layout).toMatchObject({
      width: 140,
      logoTier: 'full',
      inputBottomMargin: 2,
    });
  });

  it('gives the body the same width at each catalogued viewport', () => {
    expect(getHomeLayout({ cols: 120, rows: 40 }).width).toBe(108);
    expect(getHomeLayout({ cols: 80, rows: 24 }).width).toBe(76);
    expect(getHomeLayout({ cols: 60, rows: 18 }).width).toBe(56);
  });

  it('budgets session rows against the seat block at each catalogued viewport', () => {
    expect(getHomeLayout({ cols: 120, rows: 40 }).recentSessionLimit).toBe(18);
    expect(getHomeLayout({ cols: 80, rows: 24 }).recentSessionLimit).toBe(5);
    expect(getHomeLayout({ cols: 60, rows: 18 }).recentSessionLimit).toBe(2);
  });

  it('keeps medium terminals on the full logo', () => {
    expect(getHomeLayout({ cols: 100, rows: 32 })).toMatchObject({
      width: 90,
      logoTier: 'full',
      inputBottomMargin: 1,
    });
  });

  it('uses the compact logo on shorter terminals', () => {
    expect(getHomeLayout({ cols: 80, rows: 20 })).toMatchObject({
      width: 76,
      logoTier: 'compact',
      inputBottomMargin: 0,
    });
  });

  it('falls back to the compact logo when the full wordmark cannot fit', () => {
    const layout = getHomeLayout({ cols: 50, rows: 30 });
    expect(layout.logoTier).toBe('compact');
  });

  it('budgets two body gap rows at narrow and wide layouts', () => {
    const narrow = getHomeLayout({ cols: 80, rows: 18 });
    const wide = getHomeLayout({ cols: 120, rows: 18 });
    expect(narrow.recentSessionLimit).toBe(2);
    expect(wide.recentSessionLimit).toBe(1);
  });

  it('does not allocate sessions when the body gaps consume a short terminal', () => {
    const layout = getHomeLayout({
      cols: 80,
      rows: 16,
      sessionCount: 2,
    });
    expect(layout.recentSessionLimit).toBe(0);
    expect(layout.showHiddenCount).toBe(false);
  });

  it('accounts focused prompt and selection-error rows before session capacity', () => {
    const baseRows = 18;
    const focusedChromeRows = 5;
    const sessionCount = 2;

    const unfocused = getHomeLayout({
      cols: 80,
      rows: baseRows,
      sessionCount,
    });
    const focusedAtSameHeight = getHomeLayout({
      cols: 80,
      rows: baseRows,
      sessionCount,
      sessionsFocused: true,
    });
    const focusedWithChromeRows = getHomeLayout({
      cols: 80,
      rows: baseRows + focusedChromeRows,
      sessionCount,
      sessionsFocused: true,
    });

    expect(focusedAtSameHeight.recentSessionLimit).toBeLessThan(unfocused.recentSessionLimit);
    expect(focusedAtSameHeight.recentSessionLimit).toBe(0);
    expect(focusedWithChromeRows.recentSessionLimit).toBe(unfocused.recentSessionLimit);
    expect(focusedWithChromeRows.showHiddenCount).toBe(false);
  });

  it('reserves a row for +N more when capacity allows more than one session row', () => {
    const layout = getHomeLayout({
      cols: 80,
      rows: 18,
      sessionCount: 25,
    });
    expect(layout.recentSessionLimit).toBe(1);
    expect(layout.showHiddenCount).toBe(true);
  });

  it('uses all safe vertical space for recent sessions on tall terminals', () => {
    const layout = getHomeLayout({ cols: 120, rows: 60 });
    expect(layout.recentSessionLimit).toBeGreaterThan(20);
  });

  it('grows the session limit monotonically with terminal height', () => {
    const limits = [14, 18, 24, 30, 42, 60].map(
      (rows) => getHomeLayout({ cols: 120, rows }).recentSessionLimit,
    );
    limits.reduce((prev, current) => {
      expect(current).toBeGreaterThanOrEqual(prev);
      return current;
    });
    expect(limits.every((n) => n >= 0)).toBe(true);
  });

  it('clamps recentSessionLimit to exactly 0 on a tiny terminal', () => {
    const layout = getHomeLayout({ cols: 80, rows: 8 });
    expect(layout.recentSessionLimit).toBe(0);
  });

  it('shifts recentSessionLimit when the sessions header gains a row at equal height', () => {
    const narrow = getHomeLayout({ cols: 100, rows: 36 }).recentSessionLimit;
    const wide = getHomeLayout({ cols: 120, rows: 36 }).recentSessionLimit;
    expect(narrow).not.toBe(wide);
    expect(narrow).toBeGreaterThan(wide);
  });

  it('pins inputBottomMargin tier boundaries at 29/30 and 37/38', () => {
    expect(getHomeLayout({ cols: 120, rows: 29 }).inputBottomMargin).toBe(0);
    expect(getHomeLayout({ cols: 120, rows: 30 }).inputBottomMargin).toBe(1);
    expect(getHomeLayout({ cols: 120, rows: 37 }).inputBottomMargin).toBe(1);
    expect(getHomeLayout({ cols: 120, rows: 38 }).inputBottomMargin).toBe(2);
  });
});
