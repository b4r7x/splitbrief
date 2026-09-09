import { describe, expect, it } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import { PLANNER_INHERITANCE } from '../../core/crew/identity.js';
import { deriveCrewRows, type CrewRow as CrewBlockRow } from '../../core/crew/rows.js';
import { getTerminalCellWidth } from '../../utils/display-text.js';
import { billingWord } from '../../core/runners/runner-billing.js';
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
/** Every row a crew can have. */
const FULL_CREW = crewOf({ implementer: CUSTOM_ENDPOINT, reviewer: CUSTOM_ENDPOINT });

function blockRows(
  rows: readonly CrewBlockRow[],
  layout: SeatBlockLayout,
): readonly ReturnType<typeof formatCrewRow>[] {
  return rows.map((row) => formatCrewRow({ row, layout }));
}

describe('planSeatBlock', () => {
  it.each([78, 70])('keeps the posture column at %i inner columns', (innerWidth) => {
    const layout = planSeatBlock({
      rows: FULL_CREW,
      verdict: undefined,
      innerWidth,
      rowBudget: 12,
    });

    expect(layout.posture).toBe(true);
    expect(blockRows(FULL_CREW, layout).some((row) => row.posture !== undefined)).toBe(true);
  });

  it('drops the posture column for the whole block once the identity would stop naming a model', () => {
    const layout = planSeatBlock({
      rows: FULL_CREW,
      verdict: undefined,
      innerWidth: 50,
      rowBudget: 12,
    });

    expect(layout.posture).toBe(false);
    for (const row of blockRows(FULL_CREW, layout)) expect(row.posture).toBeUndefined();
  });

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
    expect(layout.identityWidth).toBe(52);
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
});

describe('formatCrewRow', () => {
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
    expect(formatted.content).toContain(row.seat.model);
    expect('branch' in formatted).toBe(false);
  });

  it('formats every posture cell with the word the one table returns', () => {
    const layout = planSeatBlock({
      rows: FULL_CREW,
      verdict: undefined,
      innerWidth: 78,
      rowBudget: 12,
    });

    expect(FULL_CREW.some((row) => row.seat.posture === 'unknown')).toBe(true);
    for (const row of FULL_CREW) {
      const formatted = formatCrewRow({ row, layout });
      expect(formatted.posture).toEqual(billingWord(row.seat.posture));
      if (row.seat.posture === 'unknown') expect(formatted.posture).toBeUndefined();
    }
  });

  it('renders a resolved posture as a non-empty lowercase word', () => {
    const row = CATALOGUED_CREW.find((candidate) => candidate.id === 'plan');
    if (row === undefined) throw new Error('no plan seat');
    const layout = planSeatBlock({
      rows: CATALOGUED_CREW,
      verdict: undefined,
      innerWidth: 78,
      rowBudget: 12,
    });

    expect(row.seat.posture).not.toBe('unknown');
    const formatted = formatCrewRow({ row, layout });
    expect(formatted.posture).toEqual(billingWord(row.seat.posture));
    expect(formatted.posture?.length).toBeGreaterThan(0);
    expect(formatted.posture).toEqual(formatted.posture?.toLowerCase());
  });
});
