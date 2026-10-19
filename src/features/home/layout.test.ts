import { describe, expect, it } from 'vitest';
import { getHomeLayout, RESTING_DOCK_ROWS } from './layout.js';

const AT_REST = { dockRows: RESTING_DOCK_ROWS, noConfig: false } as const;

describe('getHomeLayout', () => {
  it('sizes the dock and body to one wide overlay budget on tall terminals', () => {
    const layout = getHomeLayout({ cols: 160, rows: 42, ...AT_REST });
    expect(layout).toMatchObject({
      width: 108,
      logoTier: 'full',
      inputBottomMargin: 2,
    });
  });

  it('gives the body the same width at each catalogued viewport', () => {
    expect(getHomeLayout({ cols: 120, rows: 40, ...AT_REST }).width).toBe(108);
    expect(getHomeLayout({ cols: 80, rows: 24, ...AT_REST }).width).toBe(76);
    expect(getHomeLayout({ cols: 60, rows: 18, ...AT_REST }).width).toBe(56);
  });

  it('budgets session rows against the seat block at each catalogued viewport', () => {
    expect(getHomeLayout({ cols: 120, rows: 40, ...AT_REST }).recentSessionLimit).toBe(18);
    expect(getHomeLayout({ cols: 80, rows: 24, ...AT_REST }).recentSessionLimit).toBe(5);
    expect(getHomeLayout({ cols: 60, rows: 18, ...AT_REST }).recentSessionLimit).toBe(2);
  });

  it('keeps medium terminals on the full logo', () => {
    expect(getHomeLayout({ cols: 100, rows: 32, ...AT_REST })).toMatchObject({
      width: 90,
      logoTier: 'full',
      inputBottomMargin: 1,
    });
  });

  it('uses the compact logo on shorter terminals', () => {
    expect(getHomeLayout({ cols: 80, rows: 20, ...AT_REST })).toMatchObject({
      width: 76,
      logoTier: 'compact',
      inputBottomMargin: 0,
    });
  });

  it('falls back to the compact logo when the full wordmark cannot fit', () => {
    const layout = getHomeLayout({ cols: 50, rows: 30, ...AT_REST });
    expect(layout.logoTier).toBe('compact');
  });

  it('budgets two body gap rows at narrow and wide layouts', () => {
    const narrow = getHomeLayout({ cols: 80, rows: 18, ...AT_REST });
    const wide = getHomeLayout({ cols: 120, rows: 18, ...AT_REST });
    expect(narrow.recentSessionLimit).toBe(2);
    expect(wide.recentSessionLimit).toBe(1);
  });

  it('does not allocate sessions when the body gaps consume a short terminal', () => {
    const layout = getHomeLayout({
      cols: 80,
      rows: 16,
      sessionCount: 2,
      ...AT_REST,
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
      ...AT_REST,
    });
    const focusedAtSameHeight = getHomeLayout({
      cols: 80,
      rows: baseRows,
      sessionCount,
      sessionsFocused: true,
      ...AT_REST,
    });
    const focusedWithChromeRows = getHomeLayout({
      cols: 80,
      rows: baseRows + focusedChromeRows,
      sessionCount,
      sessionsFocused: true,
      ...AT_REST,
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
      ...AT_REST,
    });
    expect(layout.recentSessionLimit).toBe(1);
    expect(layout.showHiddenCount).toBe(true);
  });

  it('uses all safe vertical space for recent sessions on tall terminals', () => {
    const layout = getHomeLayout({ cols: 120, rows: 60, ...AT_REST });
    expect(layout.recentSessionLimit).toBeGreaterThan(20);
  });

  it('grows the session limit monotonically with terminal height', () => {
    const limits = [14, 18, 24, 30, 42, 60].map(
      (rows) => getHomeLayout({ cols: 120, rows, ...AT_REST }).recentSessionLimit,
    );
    limits.reduce((prev, current) => {
      expect(current).toBeGreaterThanOrEqual(prev);
      return current;
    });
    expect(limits.every((n) => n >= 0)).toBe(true);
  });

  it('clamps recentSessionLimit to exactly 0 on a tiny terminal', () => {
    const layout = getHomeLayout({ cols: 80, rows: 8, ...AT_REST });
    expect(layout.recentSessionLimit).toBe(0);
  });

  it('shifts recentSessionLimit when the sessions header gains a row at equal height', () => {
    const narrow = getHomeLayout({ cols: 100, rows: 36, ...AT_REST }).recentSessionLimit;
    const wide = getHomeLayout({ cols: 120, rows: 36, ...AT_REST }).recentSessionLimit;
    expect(narrow).not.toBe(wide);
    expect(narrow).toBeGreaterThan(wide);
  });

  it('lets a two-row dock growth take the blank tail rows before any content', () => {
    expect(
      getHomeLayout({ cols: 80, rows: 24, sessionCount: 25, dockRows: 6, noConfig: false }),
    ).toEqual(getHomeLayout({ cols: 80, rows: 24, sessionCount: 25, ...AT_REST }));
  });

  it('shrinks the session list before the logo while the list keeps a row and its count', () => {
    const layout = getHomeLayout({
      cols: 80,
      rows: 24,
      sessionCount: 25,
      dockRows: 7,
      noConfig: false,
    });
    expect(layout).toMatchObject({
      showLogo: true,
      recentSessionLimit: 3,
      showHiddenCount: true,
    });
  });

  it('hides the logo before the crew block or the more row at 60x18 under a long draft and message', () => {
    // A four-row message over a six-row draft in its box: 4 + 6 + 2 rows.
    const layout = getHomeLayout({
      cols: 60,
      rows: 18,
      sessionCount: 8,
      dockRows: 12,
      noConfig: false,
    });
    expect(layout.showLogo).toBe(false);
    expect(layout.recentSessionLimit).toBe(1);
    expect(layout.showHiddenCount).toBe(true);
  });

  it('gives the logo rows to the session list when a four-row message hides the logo', () => {
    const layout = getHomeLayout({
      cols: 60,
      rows: 18,
      sessionCount: 8,
      dockRows: 7,
      noConfig: false,
    });
    expect(layout).toMatchObject({
      showLogo: false,
      recentSessionLimit: 6,
      showHiddenCount: true,
      sessionCapacity: 7,
    });
  });

  it('keeps the logo when a four-row message leaves room for the crew and no sessions exist', () => {
    expect(getHomeLayout({ cols: 60, rows: 18, dockRows: 7, noConfig: false }).showLogo).toBe(true);
  });

  it('lets the No config notice take the blank tail rows of a resting home', () => {
    for (const viewport of [
      { cols: 120, rows: 40 },
      { cols: 80, rows: 24 },
      { cols: 60, rows: 18 },
    ]) {
      expect(
        getHomeLayout({
          ...viewport,
          sessionCount: 25,
          dockRows: RESTING_DOCK_ROWS,
          noConfig: true,
        }),
      ).toEqual(
        getHomeLayout({
          ...viewport,
          sessionCount: 25,
          dockRows: RESTING_DOCK_ROWS,
          noConfig: false,
        }),
      );
    }
  });

  it('counts the No config notice so a long draft keeps the more row at 80x24', () => {
    const layout = getHomeLayout({
      cols: 80,
      rows: 24,
      sessionCount: 12,
      dockRows: 8,
      noConfig: true,
    });
    expect(layout).toMatchObject({
      showLogo: false,
      recentSessionLimit: 7,
      showHiddenCount: true,
      sessionCapacity: 8,
    });
  });

  it('counts the No config notice so a long draft keeps the more row at 60x18', () => {
    const layout = getHomeLayout({
      cols: 60,
      rows: 18,
      sessionCount: 8,
      dockRows: 9,
      noConfig: true,
    });
    expect(layout).toMatchObject({
      showLogo: false,
      recentSessionLimit: 2,
      showHiddenCount: true,
      sessionCapacity: 3,
    });
  });

  it('pins inputBottomMargin tier boundaries at 29/30 and 37/38', () => {
    expect(getHomeLayout({ cols: 120, rows: 29, ...AT_REST }).inputBottomMargin).toBe(0);
    expect(getHomeLayout({ cols: 120, rows: 30, ...AT_REST }).inputBottomMargin).toBe(1);
    expect(getHomeLayout({ cols: 120, rows: 37, ...AT_REST }).inputBottomMargin).toBe(1);
    expect(getHomeLayout({ cols: 120, rows: 38, ...AT_REST }).inputBottomMargin).toBe(2);
  });
});
