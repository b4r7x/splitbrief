import { describe, expect, it } from 'vitest';
import type { Phase } from '../../../core/schemas/enums.js';
import { PHASES } from '../../../core/schemas/enums.js';
import type { EngineEvent } from '../../../engine/events/types.js';
import {
  BOTTOM_FIXED_CHROME_ROWS,
  BOTTOM_FOOTER_DIVIDER_ROWS,
  RAIL_MARKER_SLOT_WIDTH,
  RAIL_SHORT_LABEL,
  RAIL_STAGES,
  TOP_FIXED_CHROME_ROWS,
  chooseFormBVariant,
  getActiveRailStage,
  getChromeContentWidth,
  getChromeHeight,
  getContentTopRow,
  getRailActiveIndex,
  getRailDriftPassed,
  getRailFormBMinWidth,
  getRailStageCompletionTimes,
  getRailStages,
  isRailCurrent,
  measureFormB,
  railConnectorWidth,
  railFormBLabel,
  railFormBSegmentWidth,
  railIsHandoff,
  railStageRole,
  selectRailForm,
} from './chrome-rows.js';

function driftReport(passed: boolean, ts = 1): EngineEvent {
  return {
    type: 'drift_report',
    ts,
    phase: 'final-review',
    passed,
    score: 1,
    errorCount: 0,
    warningCount: 0,
  };
}

function plannerText(phase: Phase, ts = 1): EngineEvent {
  return { type: 'planner_text', ts, phase, text: 'x' };
}

describe('getChromeContentWidth', () => {
  it('spans the full terminal width and clamps to one column', () => {
    expect(getChromeContentWidth(120)).toBe(120);
    expect(getChromeContentWidth(0)).toBe(1);
  });
});

describe('getChromeHeight', () => {
  it('sums top + bottom + inputRows for the baseline horizontal rail', () => {
    const inputRows = 2;
    expect(getChromeHeight(inputRows)).toBe(
      TOP_FIXED_CHROME_ROWS + BOTTOM_FIXED_CHROME_ROWS + inputRows,
    );
  });

  it('each additional input row increases chrome height by exactly 1', () => {
    const base = getChromeHeight(1);
    expect(getChromeHeight(4) - base).toBe(3);
  });
});

describe('bottom footer chrome', () => {
  it('reserves divider, feedback, and the one-row input footer before variable composer rows', () => {
    expect(BOTTOM_FOOTER_DIVIDER_ROWS).toBe(1);
    expect(BOTTOM_FIXED_CHROME_ROWS).toBe(3);
    expect(BOTTOM_FIXED_CHROME_ROWS).toBe(2 + BOTTOM_FOOTER_DIVIDER_ROWS);
  });
});

describe('getContentTopRow', () => {
  it('starts after the baseline top chrome rows', () => {
    expect(getContentTopRow()).toBe(TOP_FIXED_CHROME_ROWS + 1);
  });
});

describe('rail phase → stage map', () => {
  it('maps every phase to a valid active index without throwing', () => {
    for (const phase of PHASES) {
      const index = getRailActiveIndex(phase);
      expect(index).toBeGreaterThanOrEqual(-1);
      expect(index).toBeLessThanOrEqual(RAIL_STAGES.length);
    }
  });

  it('folds research into the spec stage', () => {
    expect(getRailActiveIndex('researching')).toBe(0);
    expect(getRailStages('researching').filter((s) => s.status === 'active')).toEqual([
      { stage: 'spec', status: 'active' },
    ]);
  });

  it('reaches the north-star: plan done and briefs active in the same frame', () => {
    const stages = getRailStages('reviewing-briefs');
    expect(stages.find((s) => s.stage === 'spec')?.status).toBe('done');
    expect(stages.find((s) => s.stage === 'plan')?.status).toBe('done');
    expect(stages.find((s) => s.stage === 'briefs')?.status).toBe('active');
    expect(stages.find((s) => s.stage === 'build')?.status).toBe('pending');
  });

  it('marks every stage pending at idle and every stage done at complete', () => {
    expect(getRailStages('idle').every((s) => s.status === 'pending')).toBe(true);
    expect(getRailStages('complete').every((s) => s.status === 'done')).toBe(true);
  });

  it('returns the active rail stage or null for terminal phases', () => {
    expect(getActiveRailStage('planning')).toEqual({ stage: 'plan', status: 'active' });
    expect(getActiveRailStage('idle')).toBeNull();
    expect(getActiveRailStage('complete')).toBeNull();
  });

  it('has exactly one active stage for any running phase', () => {
    for (const phase of PHASES) {
      if (phase === 'idle' || phase === 'complete') continue;
      const active = getRailStages(phase).filter((s) => s.status === 'active');
      expect(active).toHaveLength(1);
    }
  });

  it('folds cancelled into the discriminant: the current stage becomes cancelled, not active', () => {
    const stages = getRailStages('implementing', { cancelled: true });
    expect(stages.filter((s) => s.status === 'active')).toHaveLength(0);
    expect(stages.find((s) => s.stage === 'build')?.status).toBe('cancelled');
    expect(stages.find((s) => s.stage === 'briefs')?.status).toBe('done');
    expect(stages.find((s) => s.stage === 'verify')?.status).toBe('pending');
  });
});

describe('isRailCurrent', () => {
  it('treats both the live and the cancelled current stage as current', () => {
    expect(isRailCurrent('active')).toBe(true);
    expect(isRailCurrent('cancelled')).toBe(true);
    expect(isRailCurrent('done')).toBe(false);
    expect(isRailCurrent('pending')).toBe(false);
  });
});

describe('railStageRole', () => {
  it('binds spec/plan/briefs to planner, build to implementer, verify to validator', () => {
    expect(railStageRole('spec')).toBe('planner');
    expect(railStageRole('plan')).toBe('planner');
    expect(railStageRole('briefs')).toBe('planner');
    expect(railStageRole('build')).toBe('implementer');
    expect(railStageRole('verify')).toBe('validator');
  });

  it('marks the two role seams (briefs→build, build→verify) as handoffs', () => {
    expect(railIsHandoff('spec', 'plan')).toBe(false);
    expect(railIsHandoff('plan', 'briefs')).toBe(false);
    expect(railIsHandoff('briefs', 'build')).toBe(true);
    expect(railIsHandoff('build', 'verify')).toBe(true);
  });
});

describe('rail Form-B width primitives', () => {
  it('opens every stage with a two-cell marker slot plus its label width', () => {
    const [spec] = getRailStages('idle');
    if (!spec) throw new Error('no spec stage');
    expect(railFormBSegmentWidth(spec, false)).toBe(RAIL_MARKER_SLOT_WIDTH + 'spec'.length);
    expect(railFormBSegmentWidth(spec, true)).toBe(
      RAIL_MARKER_SLOT_WIDTH + RAIL_SHORT_LABEL.spec.length,
    );
    expect(railFormBLabel(spec, { short: false })).toBe('spec');
    expect(railFormBLabel(spec, { short: true })).toBe('spc');
  });

  it('measures the same-role chevron at 3 cells and the handoff arrow per tier', () => {
    expect(railConnectorWidth(false, 'unicode')).toBe(3);
    expect(railConnectorWidth(true, 'unicode')).toBe(3);
    expect(railConnectorWidth(false, 'ascii')).toBe(3);
    // The ascii handoff renders ` -> ` (4 cells); geometry must track it so clicks stay aligned.
    expect(railConnectorWidth(true, 'ascii')).toBe(4);
  });

  it('sums the full and short five-stage lines from the shared primitives', () => {
    const stages = getRailStages('implementing');
    // markers 5×2=10, labels spec/plan/briefs/build/verify=25, connectors ›››→→? -> two chevrons +
    // two arrows = 3+3+3+3 (unicode) = 12.
    expect(measureFormB(stages, false, 'unicode')).toBe(10 + 25 + 12);
    expect(measureFormB(stages, true, 'unicode')).toBe(10 + 15 + 12);
    // ascii widens the two handoff arrows to ` -> ` (4 each).
    expect(measureFormB(stages, false, 'ascii')).toBe(10 + 25 + 14);
    expect(measureFormB(stages, true, 'ascii')).toBe(10 + 15 + 14);
  });

  it('keeps full labels while they fit and collapses to short labels under pressure', () => {
    const stages = getRailStages('implementing');
    const full = measureFormB(stages, false, 'unicode');
    expect(chooseFormBVariant(stages, full, 'unicode')).toEqual({ short: false });
    expect(chooseFormBVariant(stages, full - 1, 'unicode')).toEqual({ short: true });
  });
});

describe('getRailFormBMinWidth', () => {
  it('is the short-label line and identical across phases (same stages, same roles)', () => {
    expect(getRailFormBMinWidth('implementing', 'unicode')).toBe(37);
    expect(getRailFormBMinWidth('implementing', 'ascii')).toBe(39);
    expect(getRailFormBMinWidth('idle', 'unicode')).toBe(
      getRailFormBMinWidth('implementing', 'unicode'),
    );
    expect(getRailFormBMinWidth('complete', 'ascii')).toBe(
      getRailFormBMinWidth('reviewing-briefs', 'ascii'),
    );
  });
});

describe('selectRailForm', () => {
  it('drops to Form C one cell before the thinnest five-stage line would overflow', () => {
    const min = getRailFormBMinWidth('implementing');
    // contentWidth = cols; at exactly `min` it fits (B), one cell under it does not (C).
    expect(selectRailForm({ phase: 'implementing', cols: min })).toBe('B');
    expect(selectRailForm({ phase: 'implementing', cols: min - 1 })).toBe('C');
  });

  it('stays horizontal (Form B) on a wide terminal and never returns the removed Form A', () => {
    expect(selectRailForm({ phase: 'idle', cols: 200 })).toBe('B');
    expect(selectRailForm({ phase: 'planning', cols: 200 })).toBe('B');
    expect(selectRailForm({ phase: 'implementing', cols: 200 })).toBe('B');
    expect(selectRailForm({ phase: 'reviewing-briefs', cols: 200 })).toBe('B');
  });

  it('falls to Form C on a very narrow terminal', () => {
    expect(selectRailForm({ phase: 'implementing', cols: 12 })).toBe('C');
  });
});

describe('getRailDriftPassed', () => {
  it('returns the most recent drift verdict, undefined when none', () => {
    expect(getRailDriftPassed([])).toBeUndefined();
    expect(getRailDriftPassed([plannerText('final-review')])).toBeUndefined();
    expect(getRailDriftPassed([driftReport(false, 1), driftReport(true, 2)])).toBe(true);
    expect(getRailDriftPassed([driftReport(false, 1), plannerText('final-review', 2)])).toBe(false);
  });
});

describe('getRailStageCompletionTimes', () => {
  it('records each stage completion at the first event that advances past it', () => {
    const times = getRailStageCompletionTimes([
      plannerText('specifying', 100),
      plannerText('planning', 200),
      plannerText('reviewing-briefs', 300),
      plannerText('implementing', 400),
    ]);
    expect(times[0]).toBe(200);
    expect(times[1]).toBe(300);
    expect(times[2]).toBe(400);
    expect(times[3]).toBe(0);
    expect(times[4]).toBe(0);
  });

  it('leaves every stage unmarked while still in the first stage', () => {
    const times = getRailStageCompletionTimes([plannerText('specifying', 100)]);
    expect(times.every((time) => time === 0)).toBe(true);
  });

  it('marks every stage done at the complete event', () => {
    const times = getRailStageCompletionTimes([
      plannerText('specifying', 100),
      plannerText('complete', 999),
    ]);
    expect(times.every((time) => time > 0)).toBe(true);
    expect(times[4]).toBe(999);
  });

  it('skips events that carry no phase', () => {
    const times = getRailStageCompletionTimes([
      { type: 'approval_mode_changed', ts: 50, mode: 'normal' },
      plannerText('planning', 200),
    ]);
    expect(times[0]).toBe(200);
  });

  it('reuses the projection for the same event array reference', () => {
    const events = [plannerText('specifying', 100), plannerText('planning', 200)];
    const first = getRailStageCompletionTimes(events);
    const second = getRailStageCompletionTimes(events);
    const recomputed = getRailStageCompletionTimes([...events, plannerText('implementing', 300)]);

    expect(second).toBe(first);
    expect(recomputed).not.toBe(first);
    expect(recomputed[2]).toBe(300);
  });
});
