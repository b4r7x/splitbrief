import { beforeEach, describe, expect, it } from 'vitest';
import { Text } from 'ink';
import { forceUnicodeGlyphs } from '#testing/helpers/glyphs.js';
import { flushEffects, renderFeature, tick } from '#testing/helpers/ink.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { _resetMouseZones } from '../../../lib/terminal/mouse-zones.js';
import { getTerminalCellWidth } from '../../../utils/display-text.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { TwoColumnPicker } from './picker.js';

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
  }) {
    const cols = opts.cols ?? 120;
    const rows = opts.rows ?? 40;
    terminalSizeStore.__testReset({ cols, rows, isSmall: cols < 120 });
    return renderFeature(
      <TwoColumnPicker<Tool, Model>
        title="Reviewer"
        leftProps={{
          items: [INHERIT, ...TOOLS, ...MANY_TOOLS],
          getKey: (t) => t.id,
          isDisabled: (t) => !!t.disabled,
          terminalPane: (t) => (t.id === INHERIT.id ? TERMINAL_PANE : undefined),
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

  it.each([
    { cols: 80, rows: 24 },
    { cols: 60, rows: 18 },
  ])('truncates the card and keeps the hint on one row at $cols columns', async (viewport) => {
    const ui = renderTerminal(viewport);
    await flushEffects();
    const frame = ui.lastFrame() ?? '';
    const lines = frame.split('\n');

    // Still one filter row (the tool column's); the card never grows one.
    expect(frame.split('Type to filter…').length - 1).toBe(1);
    // The card's first content line no longer fits, so it is truncated, not wrapped.
    expect(frame).toContain('The review seat runs w');
    expect(frame).not.toContain(TERMINAL_PANE.lines[0]);

    const hintRows = lines.filter((line) => line.includes('↑↓ select'));
    expect(hintRows).toHaveLength(1);
    // Keys first: the terminal verb rides with them, never behind a wrap.
    expect((hintRows[0] ?? '').trim().startsWith(`↑↓ select · ⏎ ${TERMINAL_PANE.verb}`)).toBe(true);
    expect(getTerminalCellWidth((hintRows[0] ?? '').trim())).toBeLessThanOrEqual(viewport.cols - 2);
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
    await tick(20);
    ui.stdin.write('\r');
    await tick(20);
    expect(confirms).toEqual([{ l: 'inherit', r: null }]);

    // Focus never left the tool column: ↓ still moves the left cursor.
    ui.stdin.write('\u001B[B');
    await tick(20);
    expect(leftChanges.at(-1)).toBe('alpha');
    ui.unmount();
  });
});
