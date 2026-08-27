import { describe, expect, it } from 'vitest';
import { forceUnicodeGlyphs } from '#testing/helpers/glyphs.js';
import type { Phase } from '../../../core/schemas/enums.js';
import { PHASES } from '../../../core/schemas/enums.js';
import type { EngineEvent } from '../../../engine/events/types.js';
import {
  RAIL_MARKER_SLOT_WIDTH,
  RAIL_SHORT_LABEL,
  RAIL_STAGES,
  FIXED_CHROME_ROWS,
  WORKFLOW_CHROME_ORDER,
  WORKFLOW_CHROME_ROWS,
  chooseFormBVariant,
  getActiveRailStage,
  getChromeContentWidth,
  getChromeHeight,
  getContentTopRow,
  getRailActiveIndex,
  getRailDriftPassed,
  getRailStages,
  getWorkflowChromeRows,
  isRailCurrent,
  measureFormB,
  railConnectorWidth,
  railFormBLabel,
  railFormBSegmentWidth,
  railIsHandoff,
  railStageCompletionTimesFromPhaseFirstSeen,
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
    expect(getChromeHeight(2)).toBe(7);
  });

  it('each additional input row increases chrome height by exactly 1', () => {
    const base = getChromeHeight(1);
    expect(getChromeHeight(4) - base).toBe(3);
  });

  it('clamps malformed composer heights to the fixed chrome rows', () => {
    expect(getChromeHeight(-4)).toBe(FIXED_CHROME_ROWS);
    expect(getChromeHeight(Number.NaN)).toBe(FIXED_CHROME_ROWS);
  });
});

describe('workflow chrome row contract', () => {
  it('keeps the body between the header divider and footer divider', () => {
    expect(WORKFLOW_CHROME_ORDER).toEqual([
      'header',
      'header-divider',
      'body',
      'footer-divider',
      'feedback',
      'composer',
      'input-footer',
    ]);
  });

  it('accounts for the composer as the only variable fixed-row block', () => {
    expect(getWorkflowChromeRows(3)).toEqual({
      ...WORKFLOW_CHROME_ROWS,
      composer: 3,
    });
    expect(getWorkflowChromeRows(-2).composer).toBe(0);
    expect(getWorkflowChromeRows(Number.POSITIVE_INFINITY).composer).toBe(0);
  });
});

describe('getContentTopRow', () => {
  it('starts after the baseline top chrome rows', () => {
    expect(getContentTopRow()).toBe(3);
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
    expect(railFormBSegmentWidth(spec, { short: false })).toBe(
      RAIL_MARKER_SLOT_WIDTH + 'spec'.length,
    );
    expect(railFormBSegmentWidth(spec, { short: true })).toBe(
      RAIL_MARKER_SLOT_WIDTH + RAIL_SHORT_LABEL.spec.length,
    );
  });

  it('rail stage labels render in Title Case across every stage', () => {
    const expected: Record<string, [string, string]> = {
      spec: ['Spec', 'Spc'],
      plan: ['Plan', 'Pln'],
      briefs: ['Briefs', 'Brf'],
      build: ['Build', 'Bld'],
      verify: ['Verify', 'Vfy'],
    };
    for (const stage of getRailStages('idle')) {
      const [full, short] = expected[stage.stage] ?? ['', ''];
      expect(railFormBLabel(stage, { short: false })).toBe(full);
      expect(railFormBLabel(stage, { short: true })).toBe(short);
    }
  });

  it('measures the same-role chevron at 3 cells and the handoff arrow per tier', () => {
    expect(railConnectorWidth({ handoff: false }, 'unicode')).toBe(3);
    expect(railConnectorWidth({ handoff: true }, 'unicode')).toBe(3);
    expect(railConnectorWidth({ handoff: false }, 'ascii')).toBe(3);
    // The ascii handoff renders ` -> ` (4 cells); geometry must track it so clicks stay aligned.
    expect(railConnectorWidth({ handoff: true }, 'ascii')).toBe(4);
  });

  it('sums the full and short five-stage lines from the shared primitives', () => {
    const stages = getRailStages('implementing');
    // markers 5×2=10, labels spec/plan/briefs/build/verify=25, connectors ›››→→? -> two chevrons +
    // two arrows = 3+3+3+3 (unicode) = 12.
    expect(measureFormB(stages, { short: false }, 'unicode')).toBe(10 + 25 + 12);
    expect(measureFormB(stages, { short: true }, 'unicode')).toBe(10 + 15 + 12);
    // ascii widens the two handoff arrows to ` -> ` (4 each).
    expect(measureFormB(stages, { short: false }, 'ascii')).toBe(10 + 25 + 14);
    expect(measureFormB(stages, { short: true }, 'ascii')).toBe(10 + 15 + 14);
  });

  it('keeps full labels while they fit and collapses to short labels under pressure', () => {
    const stages = getRailStages('implementing');
    const full = measureFormB(stages, { short: false }, 'unicode');
    expect(chooseFormBVariant(stages, full, 'unicode')).toEqual({ short: false });
    expect(chooseFormBVariant(stages, full - 1, 'unicode')).toEqual({ short: true });
  });
});

describe('selectRailForm', () => {
  it('drops to Form C one cell before the thinnest five-stage line would overflow', () => {
    forceUnicodeGlyphs();
    const stages = getRailStages('implementing');
    const min = measureFormB(stages, { short: true }, 'unicode');
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

describe('railStageCompletionTimesFromPhaseFirstSeen', () => {
  it('records each stage completion at the first-seen phase that advances past it', () => {
    const times = railStageCompletionTimesFromPhaseFirstSeen({
      specifying: 100,
      planning: 200,
      'reviewing-briefs': 300,
      implementing: 400,
    });
    expect(times[0]).toBe(200);
    expect(times[1]).toBe(300);
    expect(times[2]).toBe(400);
    expect(times[3]).toBe(0);
    expect(times[4]).toBe(0);
  });

  it('leaves every stage unmarked while still in the first stage', () => {
    const times = railStageCompletionTimesFromPhaseFirstSeen({ specifying: 100 });
    expect(times.every((time) => time === 0)).toBe(true);
  });

  it('marks every stage done at the complete phase', () => {
    const times = railStageCompletionTimesFromPhaseFirstSeen({ specifying: 100, complete: 999 });
    expect(times.every((time) => time > 0)).toBe(true);
    expect(times[4]).toBe(999);
  });

  it('takes the earliest first-seen phase when multiple phases clear the same stage', () => {
    const times = railStageCompletionTimesFromPhaseFirstSeen({
      specifying: 100,
      planning: 250,
      'reviewing-briefs': 200,
    });
    expect(times[0]).toBe(200);
  });
});
