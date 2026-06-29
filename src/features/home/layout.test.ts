import { describe, expect, it } from 'vitest';
import { getHomeLayout, getConfigSummaryHeight } from './layout.js';

describe('getHomeLayout', () => {
  it('centers a capped body inside a wider dock on tall terminals', () => {
    const layout = getHomeLayout({ cols: 160, rows: 42, isSmall: false, hasSkills: false });
    expect(layout).toMatchObject({
      inputWidth: 92,
      bodyWidth: 72,
      logoTier: 'full',
      inputBottomMargin: 2,
    });
  });

  it('keeps medium terminals on the full logo', () => {
    expect(getHomeLayout({ cols: 100, rows: 32, isSmall: true, hasSkills: false })).toMatchObject({
      inputWidth: 70,
      bodyWidth: 70,
      logoTier: 'full',
      inputBottomMargin: 1,
    });
  });

  it('uses the compact logo on shorter terminals', () => {
    expect(getHomeLayout({ cols: 80, rows: 20, isSmall: true, hasSkills: false })).toMatchObject({
      inputWidth: 70,
      bodyWidth: 70,
      logoTier: 'compact',
      inputBottomMargin: 0,
    });
  });

  it('falls back to the compact logo when cols < 44 even on a tall terminal', () => {
    const layout = getHomeLayout({ cols: 40, rows: 30, isSmall: false, hasSkills: false });
    expect(layout.logoTier).toBe('compact');
  });

  it('still shows recent sessions on a short terminal (Problem 1)', () => {
    const layout = getHomeLayout({ cols: 80, rows: 16, isSmall: true, hasSkills: false });
    expect(layout.recentSessionLimit).toBeGreaterThan(0);
  });

  it('keeps one session row when that is the only safe row before the input', () => {
    const layout = getHomeLayout({
      cols: 80,
      rows: 16,
      isSmall: true,
      hasSkills: false,
      sessionCount: 30,
    });
    expect(layout.recentSessionLimit).toBe(1);
    expect(layout.showHiddenCount).toBe(false);
  });

  it('accounts focused prompt and selection-error rows before session capacity', () => {
    const baseRows = 16;
    const focusedChromeRows = 5;
    const sessionCount = 30;

    const unfocused = getHomeLayout({
      cols: 80,
      rows: baseRows,
      isSmall: true,
      hasSkills: false,
      sessionCount,
    });
    const focusedAtSameHeight = getHomeLayout({
      cols: 80,
      rows: baseRows,
      isSmall: true,
      hasSkills: false,
      sessionCount,
      sessionsFocused: true,
    });
    const focusedWithChromeRows = getHomeLayout({
      cols: 80,
      rows: baseRows + focusedChromeRows,
      isSmall: true,
      hasSkills: false,
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
      hasSkills: false,
      sessionCount: 25,
    });
    expect(layout.recentSessionLimit).toBeGreaterThan(0);
    expect(layout.showHiddenCount).toBe(true);
  });

  it('uses all safe vertical space for recent sessions on tall terminals', () => {
    const layout = getHomeLayout({ cols: 120, rows: 60, isSmall: false, hasSkills: false });
    expect(layout.recentSessionLimit).toBeGreaterThan(20);
  });

  it('grows the session limit monotonically with terminal height', () => {
    const limits = [14, 18, 24, 30, 42, 60].map(
      (rows) =>
        getHomeLayout({ cols: 120, rows, isSmall: false, hasSkills: false }).recentSessionLimit,
    );
    limits.reduce((prev, current) => {
      expect(current).toBeGreaterThanOrEqual(prev);
      return current;
    });
    expect(limits.every((n) => n >= 0)).toBe(true);
  });

  it('clamps recentSessionLimit to exactly 0 on a tiny terminal', () => {
    const layout = getHomeLayout({ cols: 80, rows: 8, isSmall: true, hasSkills: false });
    expect(layout.recentSessionLimit).toBe(0);
  });

  it('lowers the session limit when hasSkills grows the expanded config block', () => {
    const withSkills = getHomeLayout({
      cols: 120,
      rows: 42,
      isSmall: false,
      hasSkills: true,
    }).recentSessionLimit;
    const without = getHomeLayout({
      cols: 120,
      rows: 42,
      isSmall: false,
      hasSkills: false,
    }).recentSessionLimit;
    expect(withSkills).toBeLessThanOrEqual(without);
    expect(withSkills).toBeLessThan(without);
  });

  it('ignores hasSkills for the session limit when the config block is compact', () => {
    const withSkills = getHomeLayout({
      cols: 120,
      rows: 20,
      isSmall: false,
      hasSkills: true,
    }).recentSessionLimit;
    const without = getHomeLayout({
      cols: 120,
      rows: 20,
      isSmall: false,
      hasSkills: false,
    }).recentSessionLimit;
    expect(withSkills).toBe(without);
  });

  it('shifts recentSessionLimit when isSmall flips the summed overhead at equal rows', () => {
    const small = getHomeLayout({
      cols: 100,
      rows: 36,
      isSmall: true,
      hasSkills: false,
    }).recentSessionLimit;
    const large = getHomeLayout({
      cols: 100,
      rows: 36,
      isSmall: false,
      hasSkills: false,
    }).recentSessionLimit;
    expect(small).not.toBe(large);
    expect(small).toBeGreaterThan(large);
  });

  it('pins inputBottomMargin tier boundaries at 29/30 and 37/38', () => {
    expect(
      getHomeLayout({ cols: 120, rows: 29, isSmall: false, hasSkills: false }).inputBottomMargin,
    ).toBe(0);
    expect(
      getHomeLayout({ cols: 120, rows: 30, isSmall: false, hasSkills: false }).inputBottomMargin,
    ).toBe(1);
    expect(
      getHomeLayout({ cols: 120, rows: 37, isSmall: false, hasSkills: false }).inputBottomMargin,
    ).toBe(1);
    expect(
      getHomeLayout({ cols: 120, rows: 38, isSmall: false, hasSkills: false }).inputBottomMargin,
    ).toBe(2);
  });
});

describe('getConfigSummaryHeight', () => {
  it('collapses to a single line when small', () => {
    expect(getConfigSummaryHeight({ isSmall: true, rows: 20, hasSkills: false })).toBe(1);
  });

  it('collapses to a single line on short terminals', () => {
    expect(getConfigSummaryHeight({ isSmall: false, rows: 20, hasSkills: true })).toBe(1);
  });

  it('uses three labeled rows on a tall terminal without skills', () => {
    expect(getConfigSummaryHeight({ isSmall: false, rows: 40, hasSkills: false })).toBe(3);
  });

  it('adds a row for the skills line when skills are active', () => {
    expect(getConfigSummaryHeight({ isSmall: false, rows: 40, hasSkills: true })).toBe(4);
  });

  it('expands exactly at the CONFIG_SUMMARY_COMPACT_ROWS=30 boundary and crosses with hasSkills', () => {
    expect(getConfigSummaryHeight({ isSmall: false, rows: 29, hasSkills: false })).toBe(1);
    expect(getConfigSummaryHeight({ isSmall: false, rows: 30, hasSkills: false })).toBe(3);
    expect(getConfigSummaryHeight({ isSmall: false, rows: 30, hasSkills: true })).toBe(4);
    expect(getConfigSummaryHeight({ isSmall: false, rows: 29, hasSkills: true })).toBe(1);
  });
});
