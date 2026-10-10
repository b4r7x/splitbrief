import { describe, expect, it } from 'vitest';
import {
  buildRailFraction,
  getRailStageZones,
  hitRailStage,
  hitTranscriptRow,
  RAIL_CONTENT_LEFT_COL,
  RAIL_STAGE_FIRST_ROW,
  resolveRailFraction,
  type RailStageZone,
} from './hit-test.js';
import type { WorkflowContentRect } from './rect.js';
import { getChromeContentWidth, WORKFLOW_GUTTER_X } from './chrome-rows.js';
import { tasksStore } from '../../../stores/workflow/tasks.js';

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

describe('rail stage hit zones', () => {
  it('derives the rail content origin from the gutter the rail row sits in', () => {
    expect(RAIL_CONTENT_LEFT_COL).toBe(WORKFLOW_GUTTER_X);
  });

  it('lays Form B stages left-to-right on the first rail row from the content edge', () => {
    const zones = getRailStageZones({
      form: 'B',
      phase: 'implementing',
      cols: 80,
      fraction: buildRailFraction('build', 3, 7),
    });
    expect(zones).toHaveLength(3);
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
    expect(hitRailStage(zones, zoneByIndex(zones, 2).right + 1, RAIL_STAGE_FIRST_ROW)).toBeNull();
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
    const zone = zoneByIndex(zones, 1);
    expect(zone.left).toBe(RAIL_CONTENT_LEFT_COL);
    expect(zone.top).toBe(RAIL_STAGE_FIRST_ROW);
  });

  it('maps an old researching run onto Plan in a narrow Form C zone', () => {
    const cols = 20;
    const maxCol = RAIL_CONTENT_LEFT_COL + getChromeContentWidth(cols) - 1;
    const zones = getRailStageZones({
      form: 'C',
      phase: 'researching',
      cols,
      fraction: '',
    });
    expect(zones).toHaveLength(1);
    const zone = zoneByIndex(zones, 0);
    expect(zone.stage).toBe('plan');
    expect(zone.left).toBe(RAIL_CONTENT_LEFT_COL);
    expect(zone.right).toBeLessThanOrEqual(maxCol);
    expect(zone.top).toBe(RAIL_STAGE_FIRST_ROW);
    expect(hitRailStage(zones, zone.left, RAIL_STAGE_FIRST_ROW)).toBe(0);
  });

  it('selects the done Review of a completed run in a narrow Form C zone', () => {
    const cols = 20;
    const maxCol = RAIL_CONTENT_LEFT_COL + getChromeContentWidth(cols) - 1;
    const zones = getRailStageZones({
      form: 'C',
      phase: 'complete',
      cols,
      fraction: '',
    });
    expect(zones).toHaveLength(1);
    const zone = zoneByIndex(zones, 2);
    expect(zone.stage).toBe('review');
    expect(zone.left).toBe(RAIL_CONTENT_LEFT_COL);
    expect(zone.right).toBeLessThanOrEqual(maxCol);
    expect(zone.top).toBe(RAIL_STAGE_FIRST_ROW);
    expect(hitRailStage(zones, zone.left, RAIL_STAGE_FIRST_ROW)).toBe(2);
  });

  it('maps a cancelled run onto its stop stage in a narrow Form C zone', () => {
    const cols = 20;
    const maxCol = RAIL_CONTENT_LEFT_COL + getChromeContentWidth(cols) - 1;
    const zones = getRailStageZones({
      form: 'C',
      phase: 'implementing',
      cols,
      fraction: '',
      cancelled: true,
    });
    expect(zones).toHaveLength(1);
    const zone = zoneByIndex(zones, 1);
    expect(zone.stage).toBe('build');
    expect(zone.left).toBe(RAIL_CONTENT_LEFT_COL);
    expect(zone.right).toBe(maxCol);
    expect(zone.top).toBe(RAIL_STAGE_FIRST_ROW);
    expect(hitRailStage(zones, zone.left, RAIL_STAGE_FIRST_ROW)).toBe(1);
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
    expect(indices).not.toContain(2);
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
  it('counts only passed briefs instead of the focused position during a live run', () => {
    expect(
      resolveRailFraction({
        phase: 'implementing',
        tasks: { ...tasksStore.get(), currentTask: 3, totalTasks: 7 },
        cancelled: false,
        buildBlockShown: false,
      }),
    ).toBe('0/7');
  });

  it('drops the fraction when cancelled so geometry matches the cancelled renderer', () => {
    expect(
      resolveRailFraction({
        phase: 'implementing',
        tasks: { ...tasksStore.get(), currentTask: 3, totalTasks: 7 },
        cancelled: true,
        buildBlockShown: false,
      }),
    ).toBe('');
  });

  it('carries no fraction for a stage that never renders one', () => {
    expect(
      resolveRailFraction({
        phase: 'final-review',
        tasks: { ...tasksStore.get(), currentTask: 7, totalTasks: 7 },
        cancelled: false,
        buildBlockShown: false,
      }),
    ).toBe('');
  });
});
