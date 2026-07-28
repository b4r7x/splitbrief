import { describe, expect, it } from 'vitest';
import { getHomeLayout } from './layout.js';

describe('getHomeLayout', () => {
  it('centers a capped body inside a wider dock on tall terminals', () => {
    const layout = getHomeLayout({ cols: 160, rows: 42, isSmall: false });
    expect(layout).toMatchObject({
      inputWidth: 92,
      bodyWidth: 72,
      logoTier: 'full',
      inputBottomMargin: 2,
    });
  });

  it('keeps medium terminals on the full logo', () => {
    expect(getHomeLayout({ cols: 100, rows: 32, isSmall: true })).toMatchObject({
      inputWidth: 70,
      bodyWidth: 70,
      logoTier: 'full',
      inputBottomMargin: 1,
    });
  });

  it('uses the compact logo on shorter terminals', () => {
    expect(getHomeLayout({ cols: 80, rows: 20, isSmall: true })).toMatchObject({
      inputWidth: 70,
      bodyWidth: 70,
      logoTier: 'compact',
      inputBottomMargin: 0,
    });
  });

  it('falls back to the compact logo when the full wordmark cannot fit', () => {
    const layout = getHomeLayout({ cols: 50, rows: 30, isSmall: true });
    expect(layout.logoTier).toBe('compact');
  });

  it('budgets two body gap rows in small and large layouts', () => {
    const small = getHomeLayout({ cols: 80, rows: 18, isSmall: true });
    const large = getHomeLayout({ cols: 120, rows: 18, isSmall: false });
    expect(small.recentSessionLimit).toBe(2);
    expect(large.recentSessionLimit).toBe(1);
  });

  it('does not allocate sessions when the body gaps consume a short terminal', () => {
    const layout = getHomeLayout({
      cols: 80,
      rows: 16,
      isSmall: true,
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
      isSmall: true,
      sessionCount,
    });
    const focusedAtSameHeight = getHomeLayout({
      cols: 80,
      rows: baseRows,
      isSmall: true,
      sessionCount,
      sessionsFocused: true,
    });
    const focusedWithChromeRows = getHomeLayout({
      cols: 80,
      rows: baseRows + focusedChromeRows,
      isSmall: true,
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
      isSmall: true,
      sessionCount: 25,
    });
    expect(layout.recentSessionLimit).toBe(1);
    expect(layout.showHiddenCount).toBe(true);
  });

  it('uses all safe vertical space for recent sessions on tall terminals', () => {
    const layout = getHomeLayout({ cols: 120, rows: 60, isSmall: false });
    expect(layout.recentSessionLimit).toBeGreaterThan(20);
  });

  it('grows the session limit monotonically with terminal height', () => {
    const limits = [14, 18, 24, 30, 42, 60].map(
      (rows) => getHomeLayout({ cols: 120, rows, isSmall: false }).recentSessionLimit,
    );
    limits.reduce((prev, current) => {
      expect(current).toBeGreaterThanOrEqual(prev);
      return current;
    });
    expect(limits.every((n) => n >= 0)).toBe(true);
  });

  it('clamps recentSessionLimit to exactly 0 on a tiny terminal', () => {
    const layout = getHomeLayout({ cols: 80, rows: 8, isSmall: true });
    expect(layout.recentSessionLimit).toBe(0);
  });

  it('shifts recentSessionLimit when isSmall flips the summed overhead at equal rows', () => {
    const small = getHomeLayout({
      cols: 100,
      rows: 36,
      isSmall: true,
    }).recentSessionLimit;
    const large = getHomeLayout({
      cols: 100,
      rows: 36,
      isSmall: false,
    }).recentSessionLimit;
    expect(small).not.toBe(large);
    expect(small).toBeGreaterThan(large);
  });

  it('pins inputBottomMargin tier boundaries at 29/30 and 37/38', () => {
    expect(getHomeLayout({ cols: 120, rows: 29, isSmall: false }).inputBottomMargin).toBe(0);
    expect(getHomeLayout({ cols: 120, rows: 30, isSmall: false }).inputBottomMargin).toBe(1);
    expect(getHomeLayout({ cols: 120, rows: 37, isSmall: false }).inputBottomMargin).toBe(1);
    expect(getHomeLayout({ cols: 120, rows: 38, isSmall: false }).inputBottomMargin).toBe(2);
  });
});
