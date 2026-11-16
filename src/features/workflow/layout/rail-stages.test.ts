import { describe, expect, it } from 'vitest';
import { getRailStages } from '../../../core/phases/rail.js';
import { EMPTY_BRIEFS } from '../../../core/run-view/briefs.js';
import { glyph } from '../../../lib/glyphs.js';
import { getTerminalCellWidth } from '../../../utils/display-text/width.js';
import { railConnectorString } from './chrome-rows.js';
import { RAIL_FORM_C_CANCELLED_SUFFIX } from './hit-test.js';
import { measureRailCells, railFormCText, resolveRailStages } from './rail-stages.js';

const DONE = glyph('stageDone');
const PENDING = glyph('stagePending');
const CANCELLED = glyph('statusCancelled');

describe('measureRailCells', () => {
  it('measures the rail it paints in form B and form C', () => {
    const arrow = railConnectorString();
    const input = {
      phase: 'implementing',
      status: 'running',
      cancelled: false,
      short: false,
      cols: 100,
      tasks: EMPTY_BRIEFS,
      events: [],
      recoveryAt: null,
      afterLastBrief: { kind: 'review', cycle: 0 },
      buildBlockShown: false,
    } as const;

    expect(measureRailCells({ ...input, form: 'B' })).toBe(
      getTerminalCellWidth(`${DONE} Plan${arrow}${DONE} Build${arrow}${PENDING} Review`),
    );
    expect(measureRailCells({ ...input, form: 'B', short: true })).toBe(
      getTerminalCellWidth(`${DONE} Pln${arrow}${DONE} Bld${arrow}${PENDING} Rvw`),
    );
    expect(measureRailCells({ ...input, form: 'C' })).toBe(getTerminalCellWidth(`${DONE} Build`));
  });
});

describe('Rail — a run with REVIEW None', () => {
  it.each([
    { status: 'paused', cancelled: false, apply: 'active' },
    { status: 'running', cancelled: true, apply: 'cancelled' },
    { status: 'paused', cancelled: true, apply: 'cancelled' },
  ] as const)(
    'keeps the review skipped and marks Apply $apply on a $status run (cancelled $cancelled) while the merged result is checked',
    ({ status, cancelled, apply }) => {
      expect(
        resolveRailStages({
          phase: 'final-review',
          status,
          cancelled,
          pendingRecovery: false,
          events: [],
          recoveryAt: null,
          afterLastBrief: { kind: 'apply' },
        }),
      ).toEqual([
        { stage: 'plan', status: 'done' },
        { stage: 'build', status: 'done' },
        { stage: 'review', status: 'skipped' },
        { stage: 'apply', status: apply },
      ]);
    },
  );
});

describe('Rail — Form C (narrow floor)', () => {
  it('builds the active stage line without a task fraction outside task stages', () => {
    expect(railFormCText({ stages: getRailStages('planning'), fraction: '' })).toBe(`${DONE} Plan`);
  });

  it('builds the active build stage line with its passed fraction', () => {
    expect(railFormCText({ stages: getRailStages('implementing'), fraction: '3/7' })).toBe(
      `${DONE} Build  3/7 passed`,
    );
  });

  it('builds the cancelled stage line without a task fraction', () => {
    expect(
      railFormCText({
        stages: getRailStages('implementing', { cancelled: true }),
        fraction: '3/7',
      }),
    ).toBe(`${CANCELLED} Build${RAIL_FORM_C_CANCELLED_SUFFIX}`);
  });
});
