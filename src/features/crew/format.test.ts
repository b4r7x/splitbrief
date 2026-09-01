import { describe, expect, it } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import type { RunnerConfig } from '../../core/config/accessors/runner-config.js';
import { formatInheritedIdentity } from '../../core/crew/identity.js';
import { deriveCrewRows, type CrewRow as CrewBlockRow } from '../../core/crew/rows.js';
import type { CliEffortChannel } from '../../core/runners/effort-channel.js';
import { getTerminalCellWidth } from '../../utils/display-text.js';
import { formatCrewRow, planSeatBlock, type SeatBlockLayout } from './format.js';

const WIDTHS = [120, 80, 60];

const ESCAPE = '\u001b';
const BELL = '\u0007';
const HOSTILE_MODEL = '\u001b[31mvendor/\u001b]0;pwned\u0007model\u001b[0m';

const PLANNER: RunnerConfig = { kind: 'cli', tool: 'claude-code', model: 'claude-sonnet-4' };

function crewOf(overrides: Parameters<typeof makeConfig>[0]): readonly CrewBlockRow[] {
  return deriveCrewRows({ config: makeConfig(overrides) });
}

/** Three seats and one effort row: the catalogued config. */
const CATALOGUED_CREW = crewOf({});
/** Three seats and two effort rows. */
const CUSTOM_ENDPOINT = {
  kind: 'api',
  provider: 'custom-endpoint',
  model: 'claude-sonnet-4',
  apiBase: 'https://api.example.test/v1',
  apiKey: 'test-key',
} as const;

const DEEP_CREW = crewOf({ implementer: CUSTOM_ENDPOINT });
/** Every row a crew can have: three seats and three effort rows. */
const FULL_CREW = crewOf({ implementer: CUSTOM_ENDPOINT, reviewer: CUSTOM_ENDPOINT });

function effortContent(channel: CliEffortChannel, value: string | undefined): string {
  const row: CrewBlockRow = {
    kind: 'effort',
    seatId: 'build',
    channel,
    value,
    editable: channel === 'effort-flag' || channel === 'variant',
    inherited: false,
    deliverable: channel !== 'none',
  };
  const layout = planSeatBlock({ rows: [row], verdict: undefined, innerWidth: 78, rowBudget: 12 });
  return formatCrewRow({ row, layout, planner: PLANNER }).content;
}

function blockRows(
  rows: readonly CrewBlockRow[],
  layout: SeatBlockLayout,
): readonly ReturnType<typeof formatCrewRow>[] {
  return rows.map((row) => formatCrewRow({ row, layout, planner: PLANNER }));
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

  it('yields the spines first when the rows overflow the budget', () => {
    const layout = planSeatBlock({
      rows: CATALOGUED_CREW,
      verdict: undefined,
      innerWidth: 50,
      rowBudget: 7,
    });

    expect(layout).toMatchObject({ verdict: false, spines: false, rows: 6 });
  });

  it('yields the verdict before the spines', () => {
    const layout = planSeatBlock({
      rows: DEEP_CREW,
      verdict: 'cross-lab',
      innerWidth: 50,
      rowBudget: 8,
    });

    expect(layout).toMatchObject({ verdict: false, spines: true, rows: 8 });
  });

  it('keeps the verdict and the spines while the budget allows them', () => {
    const layout = planSeatBlock({
      rows: FULL_CREW,
      verdict: 'cross-lab',
      innerWidth: 78,
      rowBudget: 12,
    });

    expect(layout).toMatchObject({ verdict: true, spines: true, rows: 9 });
  });
});

describe('formatCrewRow', () => {
  it.each(WIDTHS)(
    'strips terminal control sequences from a seat identity at %i columns',
    (innerWidth) => {
      const rows = crewOf({ planner: { kind: 'cli', tool: 'claude-code', model: HOSTILE_MODEL } });
      const row = rows.find((candidate) => candidate.kind === 'seat' && candidate.id === 'plan');
      if (row === undefined) throw new Error('no plan seat');
      const layout = planSeatBlock({ rows, verdict: undefined, innerWidth, rowBudget: 12 });
      const formatted = formatCrewRow({ row, layout, planner: PLANNER });

      expect(formatted.content).not.toContain(ESCAPE);
      expect(formatted.content).not.toContain(BELL);
      expect(formatted.content).not.toContain('pwned');
      expect(getTerminalCellWidth(formatted.content)).toBeLessThanOrEqual(layout.identityWidth);
    },
  );

  it('reads an inherited review seat off the planner', () => {
    const row = CATALOGUED_CREW.find(
      (candidate) => candidate.kind === 'seat' && candidate.id === 'review',
    );
    if (row === undefined) throw new Error('no review seat');
    const layout = planSeatBlock({
      rows: CATALOGUED_CREW,
      verdict: undefined,
      innerWidth: 78,
      rowBudget: 12,
    });

    expect(formatCrewRow({ row, layout, planner: PLANNER }).content).toContain(
      formatInheritedIdentity(PLANNER),
    );
  });

  it('still prints n/a for a tool with no effort channel', () => {
    const rows = crewOf({ implementer: { kind: 'cli', tool: 'codex' } });
    const row = rows.find(
      (candidate) => candidate.kind === 'effort' && candidate.seatId === 'build',
    );
    if (row === undefined) throw new Error('no build effort row');
    const layout = planSeatBlock({ rows, verdict: undefined, innerWidth: 78, rowBudget: 12 });
    const formatted = formatCrewRow({ row, layout, planner: PLANNER });

    expect(formatted.content).toBe('n/a');
  });

  it('prints an opencode seat its saved variant instead of n/a', () => {
    expect(effortContent('variant', 'xhigh')).toBe('xhigh');
  });

  it('prints a cursor seat the effort its model id spells', () => {
    expect(effortContent('model-id', 'high')).toBe('high');
  });

  it('prints auto for a deliverable channel with no value yet', () => {
    expect(effortContent('variant', undefined)).toBe('auto');
  });

  it('renders inherited review effort with from planner suffix', () => {
    const rows = crewOf({
      planner: { kind: 'cli', tool: 'claude-code', model: 'claude-sonnet-4', effort: 'high' },
    });
    const row = rows.find(
      (candidate) => candidate.kind === 'effort' && candidate.seatId === 'review',
    );
    if (row === undefined) throw new Error('no review effort row');
    const layout = planSeatBlock({ rows, verdict: undefined, innerWidth: 78, rowBudget: 12 });
    const formatted = formatCrewRow({ row, layout, planner: PLANNER });

    expect(formatted.content).toContain('high · from planner');
  });

  it('renders auto from planner for an inherited review seat when planner effort is unset', () => {
    const rows = crewOf({
      planner: { kind: 'cli', tool: 'claude-code', model: 'claude-sonnet-4' },
    });
    const row = rows.find(
      (candidate) => candidate.kind === 'effort' && candidate.seatId === 'review',
    );
    if (row === undefined) throw new Error('no review effort row');
    const layout = planSeatBlock({ rows, verdict: undefined, innerWidth: 78, rowBudget: 12 });
    const formatted = formatCrewRow({ row, layout, planner: PLANNER });

    expect(formatted.content).toContain('auto · from planner');
  });

  it('closes every branch once the spines have yielded', () => {
    const spined = planSeatBlock({
      rows: FULL_CREW,
      verdict: undefined,
      innerWidth: 78,
      rowBudget: 12,
    });
    const flat = planSeatBlock({
      rows: FULL_CREW,
      verdict: undefined,
      innerWidth: 78,
      rowBudget: 7,
    });

    expect(blockRows(FULL_CREW, spined).map((row) => row.branch)).toContain('mid');
    for (const row of blockRows(FULL_CREW, flat)) {
      expect(row.branch === 'node' || row.branch === 'last').toBe(true);
    }
  });
});
