import { describe, expect, it } from 'vitest';
import { forceUnicodeGlyphs } from '#testing/helpers/glyphs.js';
import { PHASES } from '../../../core/schemas/enums.js';
import {
  RAIL_STAGES,
  getActiveRailStage,
  getRailActiveIndex,
  getRailStages,
  isRailCurrent,
  railStageCompletionTimesFromPhaseFirstSeen,
  railStageRole,
} from '../../../core/phases/rail.js';
import {
  RAIL_MARKER_SLOT_WIDTH,
  RAIL_SHORT_LABEL,
  FIXED_CHROME_ROWS,
  getChromeContentWidth,
  getChromeHeight,
  getContentTopRow,
  getContentTopRowIndex,
  getProgressRows,
  measureFormB,
  railConnectorWidth,
  railFormBLabel,
  railFormBSegmentWidth,
  selectRailFormAndLine,
  WORKFLOW_GUTTER_X,
} from './chrome-rows.js';

describe('getChromeContentWidth', () => {
  it('keeps the one-cell transcript lead as the gutter on both edges', () => {
    expect(WORKFLOW_GUTTER_X).toBe(1);
  });

  it('spans the width inside the gutter and clamps to one column', () => {
    expect(getChromeContentWidth(120)).toBe(118);
    expect(getChromeContentWidth(0)).toBe(1);
  });
});

describe('getChromeHeight', () => {
  it('sums top + bottom + inputRows for the baseline horizontal rail', () => {
    expect(getChromeHeight(2, 1)).toBe(7);
  });

  it('each additional input row increases chrome height by exactly 1', () => {
    const base = getChromeHeight(1, 1);
    expect(getChromeHeight(4, 1) - base).toBe(3);
  });

  it('clamps malformed composer heights to the fixed chrome rows', () => {
    expect(getChromeHeight(-4, 1)).toBe(FIXED_CHROME_ROWS + 1);
    expect(getChromeHeight(Number.NaN, 1)).toBe(FIXED_CHROME_ROWS + 1);
  });
});

describe('getContentTopRow', () => {
  it('starts after the baseline top chrome rows', () => {
    expect(getContentTopRow()).toBe(3);
  });

  it('states the same boundary in the frame row numbering', () => {
    expect(getContentTopRowIndex()).toBe(getContentTopRow() - 1);
    expect(getContentTopRowIndex()).toBe(2);
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

  it("folds an old run's research and briefs gate into the plan stage", () => {
    expect(getRailActiveIndex('researching')).toBe(0);
    expect(getRailActiveIndex('reviewing-briefs')).toBe(0);
    expect(getRailStages('reviewing-briefs').filter((s) => s.status === 'active')).toEqual([
      { stage: 'plan', status: 'active' },
    ]);
  });

  it('marks plan done and build active in the same frame', () => {
    const stages = getRailStages('implementing');
    expect(stages.find((s) => s.stage === 'plan')?.status).toBe('done');
    expect(stages.find((s) => s.stage === 'build')?.status).toBe('active');
    expect(stages.find((s) => s.stage === 'review')?.status).toBe('pending');
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
    expect(stages.find((s) => s.stage === 'plan')?.status).toBe('done');
    expect(stages.find((s) => s.stage === 'review')?.status).toBe('pending');
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
  it('binds plan to planner, build to implementer, review to validator', () => {
    expect(railStageRole('plan')).toBe('planner');
    expect(railStageRole('build')).toBe('implementer');
    expect(railStageRole('review')).toBe('validator');
  });
});

describe('rail Form-B width primitives', () => {
  it('opens every stage with a two-cell marker slot plus its label width', () => {
    const [plan] = getRailStages('idle');
    if (!plan) throw new Error('no plan stage');
    expect(railFormBSegmentWidth(plan, { short: false })).toBe(
      RAIL_MARKER_SLOT_WIDTH + 'plan'.length,
    );
    expect(railFormBSegmentWidth(plan, { short: true })).toBe(
      RAIL_MARKER_SLOT_WIDTH + RAIL_SHORT_LABEL.plan.length,
    );
  });

  it('rail stage labels render in Title Case across every stage', () => {
    const expected: Record<string, [string, string]> = {
      plan: ['Plan', 'Pln'],
      build: ['Build', 'Bld'],
      review: ['Review', 'Rvw'],
    };
    for (const stage of getRailStages('idle')) {
      const [full, short] = expected[stage.stage] ?? ['', ''];
      expect(railFormBLabel(stage, { short: false })).toBe(full);
      expect(railFormBLabel(stage, { short: true })).toBe(short);
    }
  });

  it('measures the handoff arrow per tier', () => {
    expect(railConnectorWidth('unicode')).toBe(3);
    // The ascii handoff renders ` -> ` (4 cells); geometry must track it so clicks stay aligned.
    expect(railConnectorWidth('ascii')).toBe(4);
  });

  it('sums the full and short three-stage lines from the shared primitives', () => {
    const stages = getRailStages('implementing');
    // markers 3×2=6, labels plan/build/review=15 (short 9), two handoff arrows = 3+3 (unicode).
    expect(measureFormB(stages, { short: false }, 'unicode')).toBe(6 + 15 + 6);
    expect(measureFormB(stages, { short: true }, 'unicode')).toBe(6 + 9 + 6);
    // ascii widens the two handoff arrows to ` -> ` (4 each).
    expect(measureFormB(stages, { short: false }, 'ascii')).toBe(6 + 15 + 8);
    expect(measureFormB(stages, { short: true }, 'ascii')).toBe(6 + 9 + 8);
  });
});

describe('selectRailFormAndLine', () => {
  it('drops to Form C one cell before the thinnest three-stage line would overflow', () => {
    forceUnicodeGlyphs();
    const stages = getRailStages('implementing');
    const full = measureFormB(stages, { short: false }, 'unicode');
    const min = measureFormB(stages, { short: true }, 'unicode');
    const noLine = { modelLineCells: 0, toolLineCells: 0 };
    const railWidths = { B: full, BShort: min, C: 10 };
    // The rail renders inside the gutter, so Form B holds while the width inside it seats the line
    // and drops one cell below it. `min` cells inside the gutter need `min` + 2 terminal columns.
    expect(selectRailFormAndLine({ cols: min + 2, railWidths, ...noLine })).toEqual({
      form: 'B',
      short: true,
      line: 'elided',
    });
    expect(selectRailFormAndLine({ cols: min + 1, railWidths, ...noLine })).toEqual({
      form: 'C',
      short: false,
      line: 'elided',
    });
  });

  it('names the tools first at 80 columns and the models first above it', () => {
    const input = { railWidths: { B: 27, C: 7 }, modelLineCells: 45, toolLineCells: 30 };

    expect(selectRailFormAndLine({ cols: 80, ...input })).toEqual({
      form: 'B',
      short: false,
      line: 'tool',
    });
    expect(selectRailFormAndLine({ cols: 81, ...input })).toEqual({
      form: 'B',
      short: false,
      line: 'model',
    });
  });

  it('seats the model line beside the one-stage rail above 80 columns', () => {
    expect(
      selectRailFormAndLine({
        cols: 120,
        railWidths: { B: 37, C: 7 },
        modelLineCells: 95,
        toolLineCells: 100,
      }),
    ).toMatchObject({ form: 'C', line: 'model' });
  });

  it('names the tools beside the one-stage rail at 80 columns when the model line is shorter', () => {
    expect(
      selectRailFormAndLine({
        cols: 80,
        railWidths: { B: 27, C: 7 },
        modelLineCells: 45,
        toolLineCells: 60,
      }),
    ).toMatchObject({ form: 'C', line: 'tool' });
  });

  it('seats the tool line beside the short-label rail at 80 columns', () => {
    expect(
      selectRailFormAndLine({
        cols: 80,
        railWidths: { B: 37, BShort: 29, C: 7 },
        modelLineCells: 60,
        toolLineCells: 42,
      }),
    ).toEqual({ form: 'B', short: true, line: 'tool' });
  });

  it('seats the model line beside the short-label rail above 80 columns', () => {
    expect(
      selectRailFormAndLine({
        cols: 120,
        railWidths: { B: 37, BShort: 29, C: 7 },
        modelLineCells: 83,
        toolLineCells: 95,
      }),
    ).toEqual({ form: 'B', short: true, line: 'model' });
    // The same widths keep the full labels while the model line fits beside them.
    expect(
      selectRailFormAndLine({
        cols: 120,
        railWidths: { B: 37, BShort: 29, C: 7 },
        modelLineCells: 60,
        toolLineCells: 42,
      }),
    ).toEqual({ form: 'B', short: false, line: 'model' });
  });

  it('falls to the one-stage rail when only it seats the tool line', () => {
    const input = {
      railWidths: { B: 37, BShort: 29, C: 7 },
      modelLineCells: 60,
      toolLineCells: 42,
    };

    expect(selectRailFormAndLine({ cols: 60, ...input })).toMatchObject({
      form: 'C',
      line: 'tool',
    });
    expect(selectRailFormAndLine({ cols: 22, ...input })).toEqual({
      form: 'C',
      short: false,
      line: 'elided',
    });
  });

  it('falls back to Form B and the elided line when no form seats a whole line', () => {
    expect(
      selectRailFormAndLine({
        cols: 120,
        railWidths: { B: 27, C: 7 },
        modelLineCells: 120,
        toolLineCells: 115,
      }),
    ).toEqual({ form: 'B', short: false, line: 'elided' });
  });

  it('offers only the form the caller can paint', () => {
    expect(
      selectRailFormAndLine({
        cols: 60,
        railWidths: { C: 7 },
        modelLineCells: 60,
        toolLineCells: 10,
      }),
    ).toMatchObject({ form: 'C', line: 'tool' });
  });
});

describe('railStageCompletionTimesFromPhaseFirstSeen', () => {
  it('records each stage completion at the first-seen phase that advances past it', () => {
    const times = railStageCompletionTimesFromPhaseFirstSeen({
      specifying: 100,
      planning: 200,
      'reviewing-briefs': 300,
      implementing: 400,
      'final-review': 500,
    });
    expect(times).toEqual([400, 500, 0]);
  });

  it('leaves every stage unmarked while still in the first stage', () => {
    const times = railStageCompletionTimesFromPhaseFirstSeen({ specifying: 100 });
    expect(times.every((time) => time === 0)).toBe(true);
  });

  it('marks every stage done at the complete phase', () => {
    const times = railStageCompletionTimesFromPhaseFirstSeen({ specifying: 100, complete: 999 });
    expect(times.every((time) => time > 0)).toBe(true);
    expect(times[2]).toBe(999);
  });

  it('takes the earliest first-seen phase when multiple phases clear the same stage', () => {
    const times = railStageCompletionTimesFromPhaseFirstSeen({
      specifying: 100,
      implementing: 250,
      'final-review': 200,
    });
    expect(times[0]).toBe(200);
  });
});

describe('getProgressRows', () => {
  it('budgets nothing outside the build and its review', () => {
    expect(getProgressRows({ phase: 'planning', cols: 120 })).toBe(0);
    expect(getProgressRows({ phase: 'idle', cols: 120 })).toBe(0);
  });

  it('collapses with the width inside the gutter while a brief is building', () => {
    expect(getProgressRows({ phase: 'implementing', cols: 122 })).toBe(2);
    expect(getProgressRows({ phase: 'implementing', cols: 121 })).toBe(2);
    expect(getProgressRows({ phase: 'implementing', cols: 120 })).toBe(2);
    expect(getProgressRows({ phase: 'implementing', cols: 119 })).toBe(3);
    expect(getProgressRows({ phase: 'validating-task', cols: 82 })).toBe(3);
    expect(getProgressRows({ phase: 'validating-task', cols: 80 })).toBe(3);
  });

  it('budgets the review block without the attempt row it no longer paints', () => {
    expect(getProgressRows({ phase: 'final-review', cols: 122 })).toBe(2);
    expect(getProgressRows({ phase: 'final-review', cols: 120 })).toBe(2);
    expect(getProgressRows({ phase: 'final-review', cols: 119 })).toBe(3);
    expect(getProgressRows({ phase: 'final-review', cols: 82 })).toBe(3);
    expect(getProgressRows({ phase: 'final-review', cols: 60 })).toBe(3);
  });

  it('stands down whenever nothing is building or something waits on an answer', () => {
    const building = { phase: 'implementing', cols: 120 } as const;
    expect(getProgressRows({ ...building, cancelled: true })).toBe(0);
    expect(getProgressRows({ ...building, halted: true })).toBe(0);
    expect(getProgressRows({ ...building, promptRows: 3 })).toBe(0);
    expect(getProgressRows({ ...building, atRest: true })).toBe(0);
    expect(getProgressRows({ ...building, parked: true })).toBe(0);
    expect(getProgressRows({ ...building, promptRows: 0, halted: false, atRest: false })).toBe(2);
  });

  it('stands the block down while the stop ladder has the run parked', () => {
    // A parked run has no attempt in flight, so it budgets no block rows in any phase the block
    // would otherwise paint in — and an unparked run of the same phase still does.
    expect(getProgressRows({ phase: 'implementing', cols: 120, parked: true })).toBe(0);
    expect(getProgressRows({ phase: 'validating-task', cols: 80, parked: true })).toBe(0);
    expect(getProgressRows({ phase: 'final-review', cols: 60, parked: true })).toBe(0);
    expect(getProgressRows({ phase: 'implementing', cols: 120, parked: false })).toBe(2);
  });

  it('leaves its rows to the chrome, so the body is measured around it', () => {
    expect(getChromeHeight(3, 1, 2)).toBe(getChromeHeight(3, 1) + 2);
  });
});
