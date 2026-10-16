import { beforeEach, describe, expect, it } from 'vitest';
import { Text } from 'ink';
import { forceUnicodeGlyphs } from '#testing/helpers/glyphs.js';
import { flushEffects, renderFeature, tick } from '#testing/helpers/ink.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { _resetMouseZones } from '../../../lib/terminal/mouse-zones.js';
import { getTerminalCellWidth } from '../../../utils/display-text.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { TwoColumnPicker } from './picker.js';
import type { TerminalPane } from './types.js';

interface Tool {
  id: string;
  displayName: string;
  disabled?: boolean;
}
interface Model {
  id: string;
  displayName: string;
}

const TOOLS: Tool[] = [
  { id: 'alpha', displayName: 'Alpha' },
  { id: 'beta', displayName: 'Beta', disabled: true },
  { id: 'gamma', displayName: 'Gamma' },
];

const MODELS_BY_TOOL: Record<string, Model[]> = {
  alpha: [
    { id: 'a-1', displayName: 'alpha-1' },
    { id: 'a-2', displayName: 'alpha-2' },
  ],
  gamma: [{ id: 'g-1', displayName: 'gamma-1' }],
};

const TERMINAL_PANE = {
  label: "Planner's setup",
  verb: "use planner's setup",
  lines: [
    'The review seat runs whatever the planner runs.',
    '',
    'Claude Code CLI · Claude Sonnet 4',
    'subscription · Network · Shell',
    '',
    'Pick a tool on the left to give the review seat its own setup.',
  ],
};

const INHERIT: Tool = { id: 'inherit', displayName: 'Same as planner' };

/** Enough tools that the tool column outgrows the card and can be seen to. */
const MANY_TOOLS: Tool[] = Array.from({ length: 11 }, (_unused, i) => ({
  id: `tool-${i}`,
  displayName: `Tool ${i}`,
}));

describe('TwoColumnPicker terminal rows', () => {
  beforeEach(() => {
    forceUnicodeGlyphs();
    resetAllStores();
    _resetMouseZones();
    terminalSizeStore.__testReset({ cols: 120, rows: 40, isSmall: false });
  });

  function renderTerminal(opts: {
    onConfirm?: ((left: Tool, right: Model | null) => void) | undefined;
    onLeftChange?: ((left: Tool) => void) | undefined;
    cols?: number;
    rows?: number;
    pane?: TerminalPane;
  }) {
    const cols = opts.cols ?? 120;
    const rows = opts.rows ?? 40;
    const pane = opts.pane ?? TERMINAL_PANE;
    terminalSizeStore.__testReset({ cols, rows, isSmall: cols < 120 });
    return renderFeature(
      <TwoColumnPicker<Tool, Model>
        title="Reviewer"
        leftProps={{
          items: [INHERIT, ...TOOLS, ...MANY_TOOLS],
          getKey: (t) => t.id,
          isDisabled: (t) => !!t.disabled,
          terminalPane: (t) => (t.id === INHERIT.id ? pane : undefined),
          renderRow: (t, { isCursor }) => <Text>{`${isCursor ? '>' : ' '}${t.displayName}`}</Text>,
        }}
        rightProps={{
          items: MODELS_BY_TOOL.alpha ?? [],
          getKey: (m) => m.id,
          renderRow: (m) => <Text>{m.displayName}</Text>,
          ...(opts.onLeftChange ? { onLeftChange: opts.onLeftChange } : {}),
        }}
        onConfirm={opts.onConfirm ?? (() => {})}
        onCancel={() => {}}
        onRefresh={() => {}}
      />,
      { cols, rows },
    );
  }

  it('renders a fixed-height card matching columnHeight instead of hugging content', async () => {
    const ui = renderTerminal({});
    await flushEffects();
    const frame = ui.lastFrame() ?? '';

    // The left column keeps its filter row; the card has none.
    expect(frame.split('Type to filter…').length - 1).toBe(1);
    for (const line of TERMINAL_PANE.lines.filter(Boolean)) {
      expect(frame).toContain(line.slice(0, 20));
    }
    expect(frame).toContain(TERMINAL_PANE.label);
    expect(frame).toContain(`⏎ ${TERMINAL_PANE.verb}`);

    // Both columns match columnHeight (maxVisible: 18 + inner chrome: 4 = 22 rows at 40 terminal rows).
    const COLUMN_HEIGHT = 22;
    const lines = frame.split('\n');
    const opens = lines.findIndex((line) => line.includes('╭'));
    const cardClose = lines.findIndex((line) => line.includes('╯'));
    const lastClose = lines.map((line) => line.includes('╯')).lastIndexOf(true);
    expect(cardClose - opens + 1).toBe(COLUMN_HEIGHT);
    // Both columns close on the same line (no content-hugging collapse).
    expect(cardClose).toBe(lastClose);
    // The card never ragged-edges: its interior rows all close at one column.
    const closingColumns = new Set(
      lines.slice(opens + 1, cardClose).map((line) => [...line].lastIndexOf('│')),
    );
    expect(closingColumns.size).toBe(1);
    ui.unmount();
  });

  /** Written to the eight rows the card has at 60x18 once its prose breaks at 23 cells. */
  const SHORT_PANE: TerminalPane = {
    ...TERMINAL_PANE,
    lines: [
      'The review seat runs whatever the planner runs.',
      '',
      'Claude Code CLI · Claude Sonnet 4',
      'subscription · Network · Shell',
    ],
  };

  it.each([
    { cols: 80, rows: 24, wrapped: ['The review seat runs whatever the', 'planner runs.'] },
    { cols: 60, rows: 18, wrapped: ['The review seat runs', 'whatever the planner', 'runs.'] },
  ])(
    "breaks the card's prose on words and keeps the hint on one row at $cols columns",
    async ({ wrapped, ...viewport }) => {
      const ui = renderTerminal({ ...viewport, pane: SHORT_PANE });
      await flushEffects();
      const frame = ui.lastFrame() ?? '';
      const lines = frame.split('\n');

      // Still one filter row (the tool column's); the card never grows one.
      expect(frame.split('Type to filter…').length - 1).toBe(1);
      // The frame row spans both boxes, so the card's own cells start where its label does.
      const labelRow = lines.findIndex((line) => line.includes(SHORT_PANE.label));
      const cardColumn = (lines[labelRow] ?? '').indexOf(SHORT_PANE.label);
      const card = lines.map((line) => line.slice(cardColumn).replace(/│\s*$/u, '').trimEnd());
      const first = card.indexOf(wrapped[0] ?? '');
      expect(first, card.join('\n')).toBeGreaterThan(labelRow);
      expect(card.slice(first, first + wrapped.length)).toEqual(wrapped);
      expect(card.slice(labelRow).join('\n')).not.toContain('…');

      const hintRows = lines.filter((line) => line.includes(`⏎ ${TERMINAL_PANE.verb}`));
      expect(hintRows).toHaveLength(1);
      expect(hintRows[0]).toContain('esc cancel');
      expect(hintRows[0]).not.toContain('…');
      expect(getTerminalCellWidth((hintRows[0] ?? '').trim())).toBeLessThanOrEqual(
        viewport.cols - 2,
      );
      ui.unmount();
    },
  );

  // The card never scrolls and never grows: at the shortest supported terminal it has ten interior
  // rows, the label and the blank under it take two, and the ninth line is paid for by squeezing
  // that blank out. The runner picker's own copy is written to the eight rows that leaves.
  it.each([
    { count: 8, air: true },
    { count: 9, air: false },
  ])("keeps the card's air for $count lines at 60x18: $air", async ({ count, air }) => {
    const lines = Array.from({ length: count }, (_unused, i) => `line-${i}`);
    const ui = renderTerminal({ cols: 60, rows: 18, pane: { ...TERMINAL_PANE, lines } });
    await flushEffects();
    const frame = ui.lastFrame() ?? '';

    for (const line of lines) expect(frame, line).toContain(line);
    const rows = frame.split('\n');
    const labelRow = rows.findIndex((row) => row.includes(TERMINAL_PANE.label));
    // The frame row spans both boxes, so the card's own cells start where its label does.
    const cardColumn = (rows[labelRow] ?? '').indexOf(TERMINAL_PANE.label);
    const underLabel = (rows[labelRow + 1] ?? '').slice(cardColumn);
    expect(/^[\s│]*$/.test(underLabel), underLabel).toBe(air);
    ui.unmount();
  });

  it('confirms the terminal row on Enter and never hands focus to the card', async () => {
    const confirms: Array<{ l: string; r: string | null }> = [];
    const leftChanges: string[] = [];
    const ui = renderTerminal({
      onConfirm: (l, r) => {
        confirms.push({ l: l.id, r: r?.id ?? null });
      },
      onLeftChange: (t) => {
        leftChanges.push(t.id);
      },
    });
    await flushEffects();

    ui.stdin.write('\u001B[C'); // right arrow is inert on a terminal row
    await flushEffects();
    ui.stdin.write('\r');
    await flushEffects();
    expect(confirms).toEqual([{ l: 'inherit', r: null }]);

    // Focus never left the tool column: ↓ still moves the left cursor.
    ui.stdin.write('\u001B[B');
    await tick(20);
    expect(leftChanges.at(-1)).toBe('alpha');
    ui.unmount();
  });
});
