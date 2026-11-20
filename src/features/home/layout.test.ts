import { describe, expect, it } from 'vitest';
import { deriveHomeLayoutState, getHomeLayout, RESTING_DOCK_ROWS } from './layout.js';

const AT_REST = { dockRows: RESTING_DOCK_ROWS, noConfig: false } as const;

describe('getHomeLayout', () => {
  it('sizes the dock and body to one wide overlay budget on tall terminals', () => {
    const layout = getHomeLayout({ cols: 160, rows: 42, ...AT_REST });
    expect(layout).toMatchObject({
      width: 108,
      heading: 'full',
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
      heading: 'full',
      inputBottomMargin: 1,
    });
  });

  it('uses the compact logo on shorter terminals', () => {
    expect(getHomeLayout({ cols: 80, rows: 20, ...AT_REST })).toMatchObject({
      width: 76,
      heading: 'compact',
      inputBottomMargin: 0,
    });
  });

  it('falls back to the compact logo when the full wordmark cannot fit', () => {
    const layout = getHomeLayout({ cols: 50, rows: 30, ...AT_REST });
    expect(layout.heading).toBe('compact');
  });

  it('puts the one-row wordmark in the logo slot when the logo is wider than the body', () => {
    expect(getHomeLayout({ cols: 41, rows: 18, ...AT_REST }).heading).toBe('compact');
    expect(getHomeLayout({ cols: 40, rows: 18, ...AT_REST }).heading).toBe('wordmark');
  });

  it('keeps the full logo over a resting dock at 120x40', () => {
    expect(getHomeLayout({ cols: 120, rows: 40, sessionCount: 8, ...AT_REST }).heading).toBe(
      'full',
    );
  });

  it('gives the heading slot to the wordmark under a long draft at 60x18, with one session and its count', () => {
    expect(
      getHomeLayout({ cols: 60, rows: 18, sessionCount: 8, dockRows: 9, noConfig: true }),
    ).toMatchObject({
      heading: 'wordmark',
      recentSessionLimit: 1,
      showHiddenCount: true,
      sessionCapacity: 2,
    });
  });

  it('gives the heading slot to the wordmark under a long draft at 80x24', () => {
    expect(
      getHomeLayout({ cols: 80, rows: 24, sessionCount: 12, dockRows: 8, noConfig: true }),
    ).toMatchObject({
      heading: 'wordmark',
      recentSessionLimit: 6,
      showHiddenCount: true,
      sessionCapacity: 7,
    });
  });

  it('keeps the wordmark and one session row under a long draft and a message at 60x18', () => {
    expect(
      getHomeLayout({ cols: 60, rows: 18, sessionCount: 8, dockRows: 12, noConfig: false }),
    ).toMatchObject({
      heading: 'wordmark',
      recentSessionLimit: 1,
      showHiddenCount: false,
    });
  });

  it('leaves the heading slot empty only when even the wordmark would cut the crew block', () => {
    expect(getHomeLayout({ cols: 60, rows: 12, dockRows: 9, noConfig: false }).heading).toBe(
      'wordmark',
    );
    expect(getHomeLayout({ cols: 60, rows: 12, dockRows: 10, noConfig: false }).heading).toBeNull();
  });

  it('gives a focused list the wordmark when it then shows more sessions', () => {
    expect(
      getHomeLayout({ cols: 80, rows: 24, sessionCount: 8, sessionsFocused: true, ...AT_REST }),
    ).toMatchObject({ heading: 'wordmark', recentSessionLimit: 7 });
  });

  it('keeps the logo over a focused list that shows every session under it', () => {
    expect(
      getHomeLayout({ cols: 120, rows: 40, sessionCount: 3, sessionsFocused: true, ...AT_REST })
        .heading,
    ).toBe('full');
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

  it('accounts the focused filter rows before session capacity', () => {
    // At 40 columns the wordmark heads both layouts, so only the filter block differs.
    const baseRows = 18;
    const focusedChromeRows = 4;
    const sessionCount = 2;

    const unfocused = getHomeLayout({
      cols: 40,
      rows: baseRows,
      sessionCount,
      ...AT_REST,
    });
    const focusedAtSameHeight = getHomeLayout({
      cols: 40,
      rows: baseRows,
      sessionCount,
      sessionsFocused: true,
      ...AT_REST,
    });
    const focusedWithChromeRows = getHomeLayout({
      cols: 40,
      rows: baseRows + focusedChromeRows,
      sessionCount,
      sessionsFocused: true,
      ...AT_REST,
    });

    expect(focusedAtSameHeight.recentSessionLimit).toBeLessThan(unfocused.recentSessionLimit);
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
      heading: 'full',
      recentSessionLimit: 3,
      showHiddenCount: true,
    });
  });

  it('gives the logo rows to the session list under the wordmark when a four-row message moves the logo out', () => {
    const layout = getHomeLayout({
      cols: 60,
      rows: 18,
      sessionCount: 8,
      dockRows: 7,
      noConfig: false,
    });
    expect(layout).toMatchObject({
      heading: 'wordmark',
      recentSessionLimit: 5,
      showHiddenCount: true,
      sessionCapacity: 6,
    });
  });

  it('keeps the logo when a four-row message leaves room for the crew and no sessions exist', () => {
    expect(getHomeLayout({ cols: 60, rows: 18, dockRows: 7, noConfig: false }).heading).toBe(
      'compact',
    );
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

  it('pins inputBottomMargin tier boundaries at 29/30 and 37/38', () => {
    expect(getHomeLayout({ cols: 120, rows: 29, ...AT_REST }).inputBottomMargin).toBe(0);
    expect(getHomeLayout({ cols: 120, rows: 30, ...AT_REST }).inputBottomMargin).toBe(1);
    expect(getHomeLayout({ cols: 120, rows: 37, ...AT_REST }).inputBottomMargin).toBe(1);
    expect(getHomeLayout({ cols: 120, rows: 38, ...AT_REST }).inputBottomMargin).toBe(2);
  });
});

describe('deriveHomeLayoutState', () => {
  const SCREEN = {
    sessionCount: 0,
    listedSessions: 0,
    sessionsFocused: false,
    toolCheck: null,
    ...AT_REST,
  } as const;
  const sessions = (count: number) => ({ sessionCount: count, listedSessions: count });

  it('lets the recent sessions take focus only where the focused list keeps a row and a run is listed', () => {
    // A long draft and a message leave the list one row, and the filter block needs four.
    const noFocusedRow = deriveHomeLayoutState({
      ...SCREEN,
      cols: 60,
      rows: 18,
      dockRows: 12,
      ...sessions(3),
    });
    expect(noFocusedRow).toMatchObject({ hasRoomForSessions: true, canFocus: false });
    const noRun = deriveHomeLayoutState({ ...SCREEN, cols: 80, rows: 24 });
    expect(noRun).toMatchObject({ hasRoomForSessions: true, canFocus: false });
    const focusable = deriveHomeLayoutState({ ...SCREEN, cols: 80, rows: 24, ...sessions(3) });
    expect(focusable).toMatchObject({ hasRoomForSessions: true, canFocus: true });
  });

  it('uses the focused layout only while the focus holds', () => {
    const focused = deriveHomeLayoutState({
      ...SCREEN,
      cols: 80,
      rows: 24,
      ...sessions(3),
      sessionsFocused: true,
    });
    expect(focused.sessionsActive).toBe(true);
    expect(focused.layout).toEqual(
      getHomeLayout({ cols: 80, rows: 24, sessionCount: 3, sessionsFocused: true, ...AT_REST }),
    );
    const noFocusedRow = deriveHomeLayoutState({
      ...SCREEN,
      cols: 60,
      rows: 18,
      dockRows: 12,
      ...sessions(3),
      sessionsFocused: true,
    });
    expect(noFocusedRow.sessionsActive).toBe(false);
    expect(noFocusedRow.layout).toEqual(
      getHomeLayout({ cols: 60, rows: 18, sessionCount: 3, dockRows: 12, noConfig: false }),
    );
  });

  it('fits the tool check box only on a terminal of 24 rows or more', () => {
    expect(deriveHomeLayoutState({ ...SCREEN, cols: 80, rows: 23 }).discoveryPanelFits).toBe(false);
    expect(deriveHomeLayoutState({ ...SCREEN, cols: 80, rows: 24 }).discoveryPanelFits).toBe(true);
  });

  it('gives the box up when the shown session rows leave it fewer than four rows', () => {
    // The box is its three rows and one breathing row.
    const oneRun = deriveHomeLayoutState({ ...SCREEN, cols: 80, rows: 24, ...sessions(1) });
    expect(oneRun.discoveryPanelFits).toBe(true);
    const twoRuns = deriveHomeLayoutState({ ...SCREEN, cols: 80, rows: 24, ...sessions(2) });
    expect(twoRuns.discoveryPanelFits).toBe(false);
    const resting = deriveHomeLayoutState({ ...SCREEN, cols: 120, rows: 40, ...sessions(13) });
    expect(resting.discoveryPanelFits).toBe(true);
    const focused = deriveHomeLayoutState({
      ...SCREEN,
      cols: 120,
      rows: 40,
      ...sessions(13),
      sessionsFocused: true,
    });
    expect(focused.discoveryPanelFits).toBe(false);
  });

  it('puts a warm check, or a running check whose box does not fit, on the hint line', () => {
    const fits = { ...SCREEN, cols: 80, rows: 24 };
    expect(deriveHomeLayoutState({ ...fits, toolCheck: 'warm' }).hintNotice).toBe(true);
    expect(deriveHomeLayoutState({ ...fits, toolCheck: 'cold' }).hintNotice).toBe(false);
    expect(deriveHomeLayoutState({ ...fits, toolCheck: 'failed' }).hintNotice).toBe(false);
    expect(deriveHomeLayoutState(fits).hintNotice).toBe(false);
    const noFit = { ...SCREEN, cols: 80, rows: 23 };
    expect(deriveHomeLayoutState({ ...noFit, toolCheck: 'cold' }).hintNotice).toBe(true);
    // A settled check is a notice above the composer at every size, never the hint line.
    expect(deriveHomeLayoutState({ ...noFit, toolCheck: 'failed' }).hintNotice).toBe(false);
    expect(deriveHomeLayoutState({ ...noFit, toolCheck: 'not-run' }).hintNotice).toBe(false);
    expect(deriveHomeLayoutState(noFit).hintNotice).toBe(false);
  });

  it('gives the collapsed seat line the session rows nothing fills, up to one row per seat', () => {
    expect(deriveHomeLayoutState({ ...SCREEN, cols: 60, rows: 18 }).seatLineRows).toBe(3);
    expect(
      deriveHomeLayoutState({ ...SCREEN, cols: 60, rows: 18, ...sessions(8) }).seatLineRows,
    ).toBe(1);
  });
});
