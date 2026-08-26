import { describe, expect, it } from 'vitest';
import { makeConfig } from '#testing/helpers/factories/config.js';
import type { RunnerConfig } from '../../core/config/accessors/runner-config.js';
import { formatInheritedIdentity } from '../../core/crew/identity.js';
import {
  crewRowFilterText,
  deriveCrewRows,
  type CrewRow as CrewBlockRow,
} from '../../core/crew/rows.js';
import type { CrewEscalateEntry } from '../../core/crew/seats.js';
import { glyph } from '../../lib/glyphs.js';
import { getTerminalCellWidth } from '../../utils/display-text.js';
import { formatCrewRow, planSeatBlock, visibleCrewRows, type SeatBlockLayout } from './format.js';

const WIDTHS = [120, 80, 60];

const LONG_DISPLAY_NAME = 'Some Extremely Long Runner Display Name From The Catalog';
const LONG_MODEL = 'vendor/some-extremely-long-model-identifier-2026-preview';
const escalate: CrewEscalateEntry = {
  label: 'escalate',
  displayName: LONG_DISPLAY_NAME,
  model: LONG_MODEL,
  posture: 'api-metered',
};

const ESCAPE = '\u001b';
const BELL = '\u0007';
const HOSTILE_MODEL = '\u001b[31mvendor/\u001b]0;pwned\u0007model\u001b[0m';

const PLANNER: RunnerConfig = { kind: 'cli', tool: 'claude-code', model: 'claude-sonnet-4' };

function crewOf(overrides: Parameters<typeof makeConfig>[0]): readonly CrewBlockRow[] {
  return deriveCrewRows({ config: makeConfig(overrides) });
}

/** Three seats, one effort row and the escalate row: the catalogued config. */
const CATALOGUED_CREW = crewOf({});
/** Three seats, two effort rows, escalate — the fullest crew short of a third effort row. */
const DEEP_CREW = crewOf({
  implementer: { kind: 'api', provider: 'anthropic', model: 'claude-sonnet-4' },
  escalation: {
    enabled: true,
    intermediateProvider: 'deepseek',
    intermediateModel: 'deepseek-chat',
  },
});
/** Every row a crew can have: three seats, three effort rows, escalate. */
const FULL_CREW = crewOf({
  implementer: { kind: 'api', provider: 'anthropic', model: 'claude-sonnet-4' },
  reviewer: {
    kind: 'api',
    provider: 'anthropic',
    model: 'claude-sonnet-4',
    apiBase: 'https://api.anthropic.com/v1',
  },
  escalation: {
    enabled: true,
    intermediateProvider: 'deepseek',
    intermediateModel: 'deepseek-chat',
  },
});

function blockRows(
  rows: readonly CrewBlockRow[],
  layout: SeatBlockLayout,
): readonly ReturnType<typeof formatCrewRow>[] {
  return rows.map((row) => formatCrewRow({ row, layout, planner: PLANNER }));
}

function escalateName(rows: readonly CrewBlockRow[]): string {
  const row = rows.find((candidate) => candidate.kind === 'escalate');
  if (row?.kind !== 'escalate' || row.entry === undefined) throw new Error('no escalate entry');
  return row.entry.displayName;
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
      rowBudget: 6,
    });

    expect(layout).toMatchObject({ verdict: false, spines: false, foldEscalate: false, rows: 5 });
  });

  it('yields the verdict before the spines', () => {
    const layout = planSeatBlock({
      rows: DEEP_CREW,
      verdict: 'cross-lab',
      innerWidth: 50,
      rowBudget: 6,
    });

    expect(layout).toMatchObject({ verdict: false, spines: false, foldEscalate: false, rows: 6 });
  });

  it('folds escalate into the build row when yielding the spines is not enough', () => {
    const layout = planSeatBlock({
      rows: FULL_CREW,
      verdict: undefined,
      innerWidth: 78,
      rowBudget: 6,
    });
    const build = FULL_CREW.find((row) => row.kind === 'seat' && row.id === 'build');
    if (build === undefined) throw new Error('no build seat');

    expect(layout).toMatchObject({ foldEscalate: true, rows: 6 });
    expect(formatCrewRow({ row: build, layout, planner: PLANNER }).content).toContain(
      `${glyph('foldMarker')} ${escalateName(FULL_CREW)}`,
    );
  });

  it('keeps the verdict and the spines while the budget allows them', () => {
    const layout = planSeatBlock({
      rows: FULL_CREW,
      verdict: 'cross-lab',
      innerWidth: 78,
      rowBudget: 12,
    });

    expect(layout).toMatchObject({ verdict: true, spines: true, foldEscalate: false, rows: 10 });
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

  it.each(WIDTHS)(
    'strips terminal control sequences from an escalate identity at %i columns',
    (innerWidth) => {
      const row: CrewBlockRow = {
        kind: 'escalate',
        entry: { ...escalate, displayName: 'Ollama', model: HOSTILE_MODEL },
      };
      const layout = planSeatBlock({ rows: [row], verdict: undefined, innerWidth, rowBudget: 12 });
      const formatted = formatCrewRow({ row, layout, planner: PLANNER });

      expect(formatted.content).not.toContain(ESCAPE);
      expect(formatted.content).not.toContain(BELL);
      expect(formatted.content).not.toContain('pwned');
      expect(getTerminalCellWidth(formatted.content)).toBeLessThanOrEqual(layout.identityWidth);
    },
  );

  it('prints an escalate identity the row filter matches word for word', () => {
    const row = FULL_CREW.find((candidate) => candidate.kind === 'escalate');
    if (row === undefined) throw new Error('no escalate row');
    const layout = planSeatBlock({
      rows: FULL_CREW,
      verdict: undefined,
      innerWidth: 120,
      rowBudget: 12,
    });
    const { content } = formatCrewRow({ row, layout, planner: PLANNER });
    const filter = crewRowFilterText(row);

    const words = content
      .toLowerCase()
      .split(/[·\s]+/)
      .filter(Boolean);

    for (const word of words) {
      expect(filter).toContain(word);
    }
  });

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

  it.each([78, 50, 44, 26])(
    'keeps the folded escalate name whole or drops the marker at %i inner columns',
    (innerWidth) => {
      const build = FULL_CREW.find((row) => row.kind === 'seat' && row.id === 'build');
      if (build === undefined) throw new Error('no build seat');
      const layout = planSeatBlock({
        rows: FULL_CREW,
        verdict: undefined,
        innerWidth,
        rowBudget: 6,
      });
      const { content } = formatCrewRow({ row: build, layout, planner: PLANNER });

      expect(layout.foldEscalate).toBe(true);
      if (content.includes(glyph('statusEscalated'))) {
        expect(content.endsWith(escalateName(FULL_CREW))).toBe(true);
      }
      expect(getTerminalCellWidth(content)).toBeLessThanOrEqual(layout.identityWidth);
    },
  );

  it('drops the escalate row from the block once it folds into the build row', () => {
    const folded = planSeatBlock({
      rows: FULL_CREW,
      verdict: undefined,
      innerWidth: 78,
      rowBudget: 6,
    });
    const open = planSeatBlock({
      rows: FULL_CREW,
      verdict: undefined,
      innerWidth: 78,
      rowBudget: 12,
    });

    expect(visibleCrewRows(FULL_CREW, folded)).toHaveLength(FULL_CREW.length - 1);
    expect(visibleCrewRows(FULL_CREW, folded).some((row) => row.kind === 'escalate')).toBe(false);
    expect(visibleCrewRows(FULL_CREW, open)).toEqual(FULL_CREW);
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
