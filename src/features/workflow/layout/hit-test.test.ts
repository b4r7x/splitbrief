import { describe, expect, it } from 'vitest';
import {
  briefListTopOffset,
  buildRailFraction,
  getRailStageZones,
  hitBriefTaskRow,
  hitRailStage,
  hitTranscriptRow,
  RAIL_CONTENT_LEFT_COL,
  RAIL_STAGE_FIRST_ROW,
  resolveRailFraction,
  type RailStageZone,
} from './hit-test.js';
import type { WorkflowContentRect } from './rect.js';

function zoneByIndex(zones: RailStageZone[], index: number): RailStageZone {
  const zone = zones.find((z) => z.index === index);
  if (!zone) throw new Error(`expected a rail zone for stage ${index}`);
  return zone;
}

function rect(overrides: Partial<WorkflowContentRect> = {}): WorkflowContentRect {
  return { left: 1, right: 80, top: 6, bottom: 25, width: 80, height: 20, ...overrides };
}

describe('hitTranscriptRow calibration', () => {
  it('maps idx = sgrY - rect.top with no off-by-one', () => {
    const r = rect();
    for (let sgrY = r.top; sgrY <= r.bottom; sgrY++) {
      expect(hitTranscriptRow({ rect: r, sgrX: 1, sgrY, visibleCount: r.height })).toBe(
        sgrY - r.top,
      );
    }
  });

  it('returns null above the top row and below the visible window', () => {
    const r = rect();
    expect(
      hitTranscriptRow({ rect: r, sgrX: 1, sgrY: r.top - 1, visibleCount: r.height }),
    ).toBeNull();
    expect(
      hitTranscriptRow({ rect: r, sgrX: 1, sgrY: r.bottom + 1, visibleCount: r.height }),
    ).toBeNull();
  });

  it('returns null outside the horizontal rect bounds', () => {
    const r = rect();
    expect(
      hitTranscriptRow({ rect: r, sgrX: r.left - 1, sgrY: r.top, visibleCount: r.height }),
    ).toBeNull();
    expect(
      hitTranscriptRow({ rect: r, sgrX: r.right + 1, sgrY: r.top, visibleCount: r.height }),
    ).toBeNull();
  });
});

describe('hitBriefTaskRow', () => {
  it('offsets the list by header chrome and divides by the row height', () => {
    const r = rect();
    const listTop = r.top + briefListTopOffset({ hasLoadError: false });
    expect(
      hitBriefTaskRow({
        rect: r,
        sgrX: 2,
        sgrY: listTop,
        hasLoadError: false,
        visibleCount: 4,
        previousCount: 0,
      }),
    ).toBe(0);
    expect(
      hitBriefTaskRow({
        rect: r,
        sgrX: 2,
        sgrY: listTop + 2,
        hasLoadError: false,
        visibleCount: 4,
        previousCount: 0,
      }),
    ).toBe(2);
    expect(
      hitBriefTaskRow({
        rect: r,
        sgrX: 2,
        sgrY: listTop + 3,
        hasLoadError: false,
        visibleCount: 4,
        previousCount: 0,
      }),
    ).toBe(3);
  });

  it('adds the windowed previousCount offset', () => {
    const r = rect();
    const listTop = r.top + briefListTopOffset({ hasLoadError: false });
    expect(
      hitBriefTaskRow({
        rect: r,
        sgrX: 2,
        sgrY: listTop + 3,
        hasLoadError: false,
        visibleCount: 4,
        previousCount: 2,
      }),
    ).toBe(5);
  });

  it('shifts the list down by one when a load error is shown', () => {
    expect(briefListTopOffset({ hasLoadError: true })).toBe(
      briefListTopOffset({ hasLoadError: false }) + 1,
    );
  });

  it('maps rows past the error line when an error co-renders above the task list', () => {
    const r = rect();
    const errorListTop = r.top + briefListTopOffset({ hasLoadError: true });
    // The first task row sits one line below the no-error case, after the error chrome row.
    expect(
      hitBriefTaskRow({
        rect: r,
        sgrX: 2,
        sgrY: errorListTop,
        hasLoadError: true,
        visibleCount: 4,
        previousCount: 0,
      }),
    ).toBe(0);
    expect(
      hitBriefTaskRow({
        rect: r,
        sgrX: 2,
        sgrY: errorListTop + 2,
        hasLoadError: true,
        visibleCount: 4,
        previousCount: 0,
      }),
    ).toBe(2);
    // A click at the no-error offset lands on the error line itself: inert.
    expect(
      hitBriefTaskRow({
        rect: r,
        sgrX: 2,
        sgrY: r.top + briefListTopOffset({ hasLoadError: false }),
        hasLoadError: true,
        visibleCount: 4,
        previousCount: 0,
      }),
    ).toBeNull();
  });

  it('returns null past the last visible row', () => {
    const r = rect();
    const listTop = r.top + briefListTopOffset({ hasLoadError: false });
    expect(
      hitBriefTaskRow({
        rect: r,
        sgrX: 2,
        sgrY: listTop + 12,
        hasLoadError: false,
        visibleCount: 4,
        previousCount: 0,
      }),
    ).toBeNull();
  });
});

describe('rail stage hit zones', () => {
  it('lays Form B stages left-to-right on the first rail row from the content edge', () => {
    const zones = getRailStageZones({
      form: 'B',
      phase: 'implementing',
      cols: 80,
      fraction: buildRailFraction('build', 3, 7),
    });
    expect(zones).toHaveLength(5);
    expect(zoneByIndex(zones, 0).left).toBe(RAIL_CONTENT_LEFT_COL);
    let prevRight = -1;
    for (const zone of zones) {
      expect(zone.top).toBe(RAIL_STAGE_FIRST_ROW);
      expect(zone.bottom).toBe(RAIL_STAGE_FIRST_ROW);
      expect(zone.left).toBeGreaterThan(prevRight);
      prevRight = zone.right;
    }
  });

  it('round-trips a click in each Form B zone back to its stage index (calibration)', () => {
    const zones = getRailStageZones({
      form: 'B',
      phase: 'implementing',
      cols: 80,
      fraction: buildRailFraction('build', 3, 7),
    });
    for (const zone of zones) {
      const mid = Math.floor((zone.left + zone.right) / 2);
      expect(hitRailStage(zones, mid, RAIL_STAGE_FIRST_ROW)).toBe(zone.index);
    }
    expect(hitRailStage(zones, RAIL_CONTENT_LEFT_COL - 1, RAIL_STAGE_FIRST_ROW)).toBeNull();
    expect(hitRailStage(zones, zoneByIndex(zones, 4).right + 1, RAIL_STAGE_FIRST_ROW)).toBeNull();
    expect(hitRailStage(zones, zoneByIndex(zones, 0).left, RAIL_STAGE_FIRST_ROW + 1)).toBeNull();
  });

  it('Form C registers only the active stage on the first rail row', () => {
    const zones = getRailStageZones({
      form: 'C',
      phase: 'implementing',
      cols: 44,
      fraction: buildRailFraction('build', 3, 7),
    });
    expect(zones).toHaveLength(1);
    const zone = zoneByIndex(zones, 3);
    expect(zone.left).toBe(RAIL_CONTENT_LEFT_COL);
    expect(zone.top).toBe(RAIL_STAGE_FIRST_ROW);
  });

  it('drops zones past the truncated rail width so a clipped label is never a phantom hotspot', () => {
    const cols = 20;
    const zones = getRailStageZones({
      form: 'B',
      phase: 'implementing',
      cols,
      fraction: buildRailFraction('build', 3, 7),
    });
    const indices = zones.map((zone) => zone.index);
    expect(indices).not.toContain(3);
    expect(indices).not.toContain(4);
    const maxCol = RAIL_CONTENT_LEFT_COL + cols - 1;
    for (const zone of zones) expect(zone.right).toBeLessThanOrEqual(maxCol);
  });

  it('keeps Form B zones independent of the fraction', () => {
    // A Form-B active stage is a fixed marker+label slot with no inline `N/M` (only Form C widens
    // for the fraction), so the fraction can never advance the trailing zones.
    const withFraction = getRailStageZones({
      form: 'B',
      phase: 'implementing',
      cols: 80,
      fraction: buildRailFraction('build', 3, 7),
    });
    const without = getRailStageZones({
      form: 'B',
      phase: 'implementing',
      cols: 80,
      fraction: '',
    });
    expect(withFraction).toEqual(without);
  });
});

describe('resolveRailFraction', () => {
  it('renders the active build/briefs fraction during a live run', () => {
    expect(
      resolveRailFraction({
        phase: 'implementing',
        currentTask: 3,
        totalTasks: 7,
        cancelled: false,
      }),
    ).toBe('3/7');
  });

  it('drops the fraction when cancelled so geometry matches the cancelled renderer', () => {
    expect(
      resolveRailFraction({
        phase: 'implementing',
        currentTask: 3,
        totalTasks: 7,
        cancelled: true,
      }),
    ).toBe('');
  });

  it('carries no fraction for a stage that never renders one', () => {
    expect(
      resolveRailFraction({
        phase: 'final-review',
        currentTask: 7,
        totalTasks: 7,
        cancelled: false,
      }),
    ).toBe('');
  });
});
