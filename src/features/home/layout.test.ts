import { describe, expect, it } from 'vitest';
import { getHomeLayout, homeLead } from './layout.js';

describe('homeLead', () => {
  it('states the whole run at every catalogued viewport instead of a cut sentence', () => {
    for (const cols of [120, 80, 60]) {
      const { width } = getHomeLayout({ cols, rows: 40 });
      const lead = homeLead(width);
      expect(lead.length).toBeLessThanOrEqual(width);
      expect(lead.startsWith('Describe a change.')).toBe(true);
      expect(lead.endsWith('.')).toBe(true);
    }
  });

  it('keeps the briefs and the diff in the sentence where they fit', () => {
    expect(homeLead(108)).toContain('small briefs');
    expect(homeLead(108)).toContain('reviews the diff');
    expect(homeLead(76)).toContain('reviews the diff');
    expect(homeLead(56)).toContain('reviews');
  });
});

describe('getHomeLayout', () => {
  it('sizes the dock and body to one wide overlay budget on tall terminals', () => {
    const layout = getHomeLayout({ cols: 160, rows: 42 });
    expect(layout).toMatchObject({
      width: 108,
      inputBottomMargin: 2,
    });
  });

  it('gives the body the same width at each catalogued viewport', () => {
    expect(getHomeLayout({ cols: 120, rows: 40 }).width).toBe(108);
    expect(getHomeLayout({ cols: 80, rows: 24 }).width).toBe(76);
    expect(getHomeLayout({ cols: 60, rows: 18 }).width).toBe(56);
  });

  it('budgets session rows against the seat block at each catalogued viewport', () => {
    expect(getHomeLayout({ cols: 120, rows: 40 }).recentSessionLimit).toBe(21);
    expect(getHomeLayout({ cols: 80, rows: 24 }).recentSessionLimit).toBe(8);
    expect(getHomeLayout({ cols: 60, rows: 18 }).recentSessionLimit).toBe(4);
  });

  it('keeps the same dock margin on medium terminals', () => {
    expect(getHomeLayout({ cols: 100, rows: 32 })).toMatchObject({
      width: 90,
      inputBottomMargin: 1,
    });
  });

  it('drops the dock margin on shorter terminals', () => {
    expect(getHomeLayout({ cols: 80, rows: 20 })).toMatchObject({
      width: 76,
      inputBottomMargin: 0,
    });
  });

  it('budgets two body gap rows at narrow and wide layouts', () => {
    const narrow = getHomeLayout({ cols: 80, rows: 18 });
    const wide = getHomeLayout({ cols: 120, rows: 18 });
    expect(narrow.recentSessionLimit).toBe(4);
    expect(wide.recentSessionLimit).toBe(3);
  });

  it('does not allocate sessions when the body gaps consume a short terminal', () => {
    const layout = getHomeLayout({
      cols: 80,
      rows: 16,
      sessionCount: 2,
    });
    expect(layout.recentSessionLimit).toBe(2);
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
    expect(layout.recentSessionLimit).toBe(3);
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
