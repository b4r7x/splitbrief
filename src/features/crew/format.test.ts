import { describe, expect, it } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { PLANNER_INHERITANCE } from '../../core/crew/identity.js';
import { deriveCrewRows, type CrewRow as CrewBlockRow } from '../../core/crew/rows.js';
import { getTerminalCellWidth } from '../../utils/display-text/width.js';

import {
  CREW_IDENTITY_COLUMN,
  formatCrewRow,
  planSeatBlock,
  type SeatBlockLayout,
} from './format.js';

const WIDTHS = [120, 80, 60];

const ESCAPE = '\u001b';
const BELL = '\u0007';
const HOSTILE_MODEL = '\u001b[31mvendor/\u001b]0;pwned\u0007model\u001b[0m';

function crewOf(overrides: Parameters<typeof makeConfig>[0]): readonly CrewBlockRow[] {
  return deriveCrewRows({ config: makeConfig(overrides) });
}

/** The catalogued config. */
const CATALOGUED_CREW = crewOf({});
const CUSTOM_ENDPOINT = {
  kind: 'api',
  provider: 'custom-endpoint',
  model: 'claude-sonnet-4',
  apiBase: 'https://api.example.test/v1',
  apiKey: 'test-key',
} as const;

const DEEP_CREW = crewOf({ implementer: CUSTOM_ENDPOINT });
/** Every row a crew can have: a CLI seat, a catalogued one, and a configured reviewer. */
const FULL_CREW = crewOf({ reviewer: CUSTOM_ENDPOINT });

function blockRows(
  rows: readonly CrewBlockRow[],
  layout: SeatBlockLayout,
): readonly ReturnType<typeof formatCrewRow>[] {
  return rows.map((row) => formatCrewRow({ row, layout }));
}

describe('planSeatBlock', () => {
  it('fits every identity in the one block budget', () => {
    const layout = planSeatBlock({
      rows: FULL_CREW,
      verdict: undefined,
      innerWidth: 78,
      rowBudget: 12,
    });

    for (const row of blockRows(FULL_CREW, layout)) {
      expect(getTerminalCellWidth(row.content)).toBeLessThanOrEqual(layout.identityWidth);
    }
  });

  it('reserves 12 columns for the cursor gutter, label and gap', () => {
    expect(CREW_IDENTITY_COLUMN).toBe(12);
    const layout = planSeatBlock({
      rows: FULL_CREW,
      verdict: undefined,
      innerWidth: 78,
      rowBudget: 12,
    });
    expect(layout.identityWidth).toBe(66);
  });

  it('yields the verdict when rows overflow the budget', () => {
    const layout = planSeatBlock({
      rows: DEEP_CREW,
      verdict: 'cross-lab',
      innerWidth: 50,
      rowBudget: 3,
    });

    expect(layout).toMatchObject({ verdict: false, rows: 3 });
  });

  it('keeps the verdict while the budget allows it', () => {
    const layout = planSeatBlock({
      rows: FULL_CREW,
      verdict: 'cross-lab',
      innerWidth: 78,
      rowBudget: 12,
    });

    expect(layout).toMatchObject({ verdict: true, rows: 4 });
  });

  it('counts one row per seat and the verdict when the seat sets a fallback', () => {
    const rows = crewOf({
      planner: { kind: 'cli', tool: 'claude-code', fallback: { tool: 'codex' } },
    });
    const layout = planSeatBlock({
      rows,
      verdict: 'cross-lab',
      innerWidth: 78,
      rowBudget: 4,
    });

    expect(layout).toMatchObject({ verdict: true, rows: 4 });
    expect(planSeatBlock({ rows, verdict: undefined, innerWidth: 78, rowBudget: 3 }).rows).toBe(3);
  });
});

describe('formatCrewRow', () => {
  it('returns no fallback field for a seat that sets one', () => {
    const rows = crewOf({
      planner: { kind: 'cli', tool: 'claude-code', fallback: { tool: 'codex' } },
    });
    const row = rows.find((candidate) => candidate.id === 'plan');
    if (row === undefined) throw new Error('no plan seat');
    const layout = planSeatBlock({ rows, verdict: undefined, innerWidth: 78, rowBudget: 3 });

    expect(formatCrewRow({ row, layout })).not.toHaveProperty('fallback');
  });

  it.each(WIDTHS)(
    'strips terminal control sequences from a seat identity at %i columns',
    (innerWidth) => {
      const rows = crewOf({ planner: { kind: 'cli', tool: 'claude-code', model: HOSTILE_MODEL } });
      const row = rows.find((candidate) => candidate.id === 'plan');
      if (row === undefined) throw new Error('no plan seat');
      const layout = planSeatBlock({ rows, verdict: undefined, innerWidth, rowBudget: 12 });
      const formatted = formatCrewRow({ row, layout });

      expect(formatted.content).not.toContain(ESCAPE);
      expect(formatted.content).not.toContain(BELL);
      expect(formatted.content).not.toContain('pwned');
      expect(getTerminalCellWidth(formatted.content)).toBeLessThanOrEqual(layout.identityWidth);
    },
  );

  it('drops a whole axis word rather than cutting inside it', () => {
    const rows = crewOf({
      planner: { kind: 'cli', tool: 'claude-code', model: 'claude-sonnet-4', effort: 'high' },
    });
    const row = rows.find((candidate) => candidate.id === 'plan');
    if (row === undefined) throw new Error('no plan seat');
    const wide = planSeatBlock({ rows, verdict: undefined, innerWidth: 120, rowBudget: 12 });
    const narrow = planSeatBlock({ rows, verdict: undefined, innerWidth: 46, rowBudget: 12 });

    expect(formatCrewRow({ row, layout: wide }).content).toBe(
      'Claude Code CLI · Claude Sonnet 4 · high',
    );
    expect(formatCrewRow({ row, layout: narrow }).content).toBe(
      'Claude Code CLI · Claude Sonnet 4',
    );
  });

  it('reads an inherited review seat off the planner', () => {
    const row = CATALOGUED_CREW.find((candidate) => candidate.id === 'review');
    if (row === undefined) throw new Error('no review seat');
    const layout = planSeatBlock({
      rows: CATALOGUED_CREW,
      verdict: undefined,
      innerWidth: 78,
      rowBudget: 12,
    });

    const formatted = formatCrewRow({ row, layout });
    expect(formatted.content.startsWith(PLANNER_INHERITANCE.mark)).toBe(true);
    expect(formatted.content).toBe(PLANNER_INHERITANCE.mark);
    expect('branch' in formatted).toBe(false);
  });

  it('sheds the mirrored planner identity rather than printing a cut model id', () => {
    const row = CATALOGUED_CREW.find((candidate) => candidate.id === 'review');
    if (row === undefined) throw new Error('no review seat');
    const layout = planSeatBlock({
      rows: CATALOGUED_CREW,
      verdict: undefined,
      innerWidth: 56,
      rowBudget: 12,
    });

    const { content } = formatCrewRow({ row, layout });
    expect(content).not.toContain('…');
    expect(content.startsWith(PLANNER_INHERITANCE.mark)).toBe(true);
  });

  it('omits the billing word from a wide crew row', () => {
    const row = CATALOGUED_CREW.find((candidate) => candidate.id === 'build');
    if (row === undefined) throw new Error('no build seat');
    const layout = planSeatBlock({
      rows: CATALOGUED_CREW,
      verdict: undefined,
      innerWidth: 78,
      rowBudget: 12,
    });

    const formatted = formatCrewRow({ row, layout });
    expect(formatted.content).not.toMatch(/\b(?:local|subscription|metered|provider)\b/i);
    expect(formatted).not.toHaveProperty('posture');
  });
});
