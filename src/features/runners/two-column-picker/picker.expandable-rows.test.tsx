import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useState, type ReactElement } from 'react';
import { Text } from 'ink';
import { forceUnicodeGlyphs } from '#testing/helpers/glyphs.js';
import { flushEffects, renderFeature, tick } from '#testing/helpers/ink.js';
import { collectClickableZones } from '#testing/helpers/mouse-zones.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { _resetMouseZones } from '../../../lib/terminal/mouse-zones.js';
import { terminalSizeStore } from '../../../stores/ui/terminal-size.js';
import { TwoColumnPicker } from './picker.js';
import type { CycleOutcome } from './types.js';

// A failing expect skips any unmount written into a test body, and the leaked Ink
// tree keeps re-registering its row zones for the rest of the file. Teardown lives
// here so a mutation proof's failures stay attributable to the test that owns them.
const mounted: Array<() => void> = [];

function mount(element: ReactElement) {
  const ui = renderFeature(element);
  mounted.push(ui.unmount);
  return ui;
}

afterEach(() => {
  while (mounted.length > 0) mounted.pop()?.();
});

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

const LEFT = '\u001B[D';

describe('TwoColumnPicker expandable right rows', () => {
  interface Route extends Model {
    activation: 'confirm' | 'expand' | 'collapse';
  }
  const ROWS: Route[] = [
    { id: 'luna', displayName: 'GPT-5.6 Luna', activation: 'expand' },
    { id: 'solo', displayName: 'Solo Model', activation: 'confirm' },
  ];

  beforeEach(() => {
    forceUnicodeGlyphs();
    resetAllStores();
    _resetMouseZones();
    terminalSizeStore.__testReset({ cols: 120, rows: 40, isSmall: false });
  });

  function renderRows(opts: {
    expanded: boolean;
    onExpand?: ((row: Route) => void) | undefined;
    onCollapse?: (() => void) | undefined;
    onConfirm?: ((left: Tool, right: Route | null) => void) | undefined;
    onCancel?: (() => void) | undefined;
  }) {
    return mount(
      <TwoColumnPicker<Tool, Route>
        title="Planner"
        initialColumn="right"
        leftProps={{
          items: TOOLS,
          getKey: (t) => t.id,
          renderRow: (t) => <Text>{t.displayName}</Text>,
        }}
        rightProps={{
          items: ROWS,
          getKey: (m) => m.id,
          renderRow: (m, { isCursor }) => <Text>{`${isCursor ? '>' : ' '}${m.displayName}`}</Text>,
          activationOf: (m) => m.activation,
          isExpanded: opts.expanded,
          ...(opts.onExpand ? { onExpand: opts.onExpand } : {}),
          ...(opts.onCollapse ? { onCollapse: opts.onCollapse } : {}),
        }}
        onConfirm={opts.onConfirm ?? (() => {})}
        onCancel={opts.onCancel ?? (() => {})}
      />,
    );
  }

  // The routes reach the picker as props, so an owner that grows the list on
  // expand is the only fixture that can prove where the cursor lands.
  const REVEALED: Route[] = [
    { id: 'luna-openrouter', displayName: 'openrouter route', activation: 'confirm' },
    { id: 'luna-fireworks', displayName: 'fireworks route', activation: 'confirm' },
  ];

  function LiveExpandingRows(props: {
    onExpand: (id: string) => void;
    onConfirm: (id: string) => void;
  }) {
    const [expanded, setExpanded] = useState(false);
    // `luna` is the last collapsed row: an index computed against the list the
    // keypress sees would clamp straight back onto it.
    const collapsed: Route[] = [
      { id: 'solo', displayName: 'Solo Model', activation: 'confirm' },
      { id: 'luna', displayName: 'GPT-5.6 Luna', activation: 'expand' },
    ];
    const rows = expanded ? [...collapsed, ...REVEALED] : collapsed;
    return (
      <TwoColumnPicker<Tool, Route>
        title="Planner"
        initialColumn="right"
        leftProps={{
          items: TOOLS,
          getKey: (t) => t.id,
          renderRow: (t) => <Text>{t.displayName}</Text>,
        }}
        rightProps={{
          items: rows,
          getKey: (m) => m.id,
          renderRow: (m, { isCursor }) => <Text>{`${isCursor ? '>' : ' '}${m.displayName}`}</Text>,
          activationOf: (m) =>
            m.id === 'luna' && expanded ? 'collapse' : (m.activation as Route['activation']),
          isExpanded: expanded,
          onExpand: (row) => {
            props.onExpand(row.id);
            setExpanded(true);
          },
          onCollapse: () => setExpanded(false),
        }}
        onConfirm={(_l, r) => props.onConfirm(r?.id ?? 'none')}
        onCancel={() => {}}
      />
    );
  }

  it('expands a multi-route row instead of confirming it', async () => {
    const expanded: string[] = [];
    const confirms: string[] = [];
    const ui = mount(
      <LiveExpandingRows
        onExpand={(id) => {
          expanded.push(id);
        }}
        onConfirm={(id) => {
          confirms.push(id);
        }}
      />,
    );
    await flushEffects();

    ui.stdin.write('\u001B[B'); // onto `luna`, the last row
    await flushEffects();
    ui.stdin.write('\r');
    await flushEffects();
    expect(expanded).toEqual(['luna']);
    expect(confirms).toEqual([]);
    // The cursor moved onto the first row the expansion revealed.
    expect(ui.lastFrame()).toContain('>openrouter route');
  });

  it('confirms a row whose route is already decided, without expanding it', async () => {
    const confirms: string[] = [];
    const expanded: string[] = [];
    const ui = renderRows({
      expanded: false,
      onExpand: (row) => {
        expanded.push(row.id);
      },
      onConfirm: (_l, r) => {
        confirms.push(r?.id ?? 'none');
      },
    });
    await flushEffects();

    ui.stdin.write('\u001B[B');
    await flushEffects();
    ui.stdin.write('\r');
    await tick(20);
    expect(confirms).toEqual(['solo']);
    expect(expanded).toEqual([]);
  });

  // Two families of the same child count: expanding the second replaces the
  // first, so the row list comes back the length it went in.
  const FAMILIES: Array<{ parent: Route; children: Route[] }> = [
    {
      parent: { id: 'nova', displayName: 'Nova', activation: 'expand' },
      children: [
        { id: 'nova-effort', displayName: 'nova effort', activation: 'confirm' },
        { id: 'nova-speed', displayName: 'nova speed', activation: 'confirm' },
      ],
    },
    {
      parent: { id: 'luna', displayName: 'GPT-5.6 Luna', activation: 'expand' },
      children: [
        { id: 'luna-effort', displayName: 'luna effort', activation: 'confirm' },
        { id: 'luna-speed', displayName: 'luna speed', activation: 'confirm' },
      ],
    },
  ];

  function LiveFamilies() {
    const [expandedId, setExpandedId] = useState<string | null>(null);
    const rows = FAMILIES.flatMap((family) =>
      family.parent.id === expandedId ? [family.parent, ...family.children] : [family.parent],
    );
    return (
      <TwoColumnPicker<Tool, Route>
        title="Planner"
        initialColumn="right"
        leftProps={{
          items: TOOLS,
          getKey: (t) => t.id,
          renderRow: (t) => <Text>{t.displayName}</Text>,
        }}
        rightProps={{
          items: rows,
          getKey: (m) => m.id,
          renderRow: (m, { isCursor }) => <Text>{`${isCursor ? '>' : ' '}${m.displayName}`}</Text>,
          activationOf: (m) => (m.id === expandedId ? 'confirm' : m.activation),
          isExpanded: expandedId !== null,
          onExpand: (row) => setExpandedId(row.id),
          onCollapse: () => setExpandedId(null),
        }}
        onConfirm={() => {}}
        onCancel={() => {}}
      />
    );
  }

  it('moves the cursor into a second expansion that leaves the row count alone', async () => {
    const ui = mount(<LiveFamilies />);
    await flushEffects();

    ui.stdin.write('\r');
    await flushEffects();
    expect(ui.lastFrame()).toContain('>nova effort');

    ui.stdin.write('\u001B[B');
    await flushEffects();
    ui.stdin.write('\u001B[B');
    await flushEffects();
    expect(ui.lastFrame()).toContain('>GPT-5.6 Luna');

    ui.stdin.write('\r');
    await flushEffects();

    expect(ui.lastFrame()).toContain('>luna effort');
  });

  it('puts the cursor back on the family whose expansion it closed', async () => {
    const ui = mount(<LiveFamilies />);
    await flushEffects();

    ui.stdin.write('\r');
    await flushEffects();
    expect(ui.lastFrame()).toContain('>nova effort');

    ui.stdin.write('\u001B');
    await flushEffects();

    expect(ui.lastFrame()).toContain('>Nova');
    expect(ui.lastFrame()).not.toContain('>GPT-5.6 Luna');
  });

  it('collapses before cancelling on escape', async () => {
    const collapses: number[] = [];
    const cancels: number[] = [];
    const ui = renderRows({
      expanded: true,
      onCollapse: () => {
        collapses.push(1);
      },
      onCancel: () => {
        cancels.push(1);
      },
    });
    await flushEffects();

    ui.stdin.write('\u001B');
    await tick(20);
    expect(collapses).toHaveLength(1);
    expect(cancels).toHaveLength(0);
  });

  it('maintains fixed slot order for hint keys across default, expanded, and terminal-pane states', async () => {
    const KEYS = ['←→', '↑↓', '⏎', 'esc'] as const;
    const [k0, k1, k2, k3] = KEYS;

    const uiDefault = mount(
      <TwoColumnPicker<Tool, Route>
        title="Planner"
        initialColumn="right"
        leftProps={{
          items: TOOLS,
          getKey: (t) => t.id,
          renderRow: (t) => <Text>{t.displayName}</Text>,
        }}
        rightProps={{
          items: ROWS,
          getKey: (m) => m.id,
          initialIndex: 1,
          renderRow: (m, { isCursor }) => <Text>{`${isCursor ? '>' : ' '}${m.displayName}`}</Text>,
        }}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    await flushEffects();

    const defaultHint =
      (uiDefault.lastFrame() ?? '').split('\n').find((line) => line.includes(k0)) ?? '';
    const d0 = defaultHint.indexOf(k0);
    const d1 = defaultHint.indexOf(k1);
    const d2 = defaultHint.indexOf(k2);
    const d3 = defaultHint.indexOf(k3);
    expect(d0).toBeGreaterThanOrEqual(0);
    expect(d1).toBeGreaterThan(d0);
    expect(d2).toBeGreaterThan(d1);
    expect(d3).toBeGreaterThan(d2);
    uiDefault.unmount();

    const uiExpanded = mount(
      <TwoColumnPicker<Tool, Route>
        title="Planner"
        initialColumn="right"
        leftProps={{
          items: TOOLS,
          getKey: (t) => t.id,
          renderRow: (t) => <Text>{t.displayName}</Text>,
        }}
        rightProps={{
          items: ROWS,
          getKey: (m) => m.id,
          isExpanded: true,
          renderRow: (m, { isCursor }) => <Text>{`${isCursor ? '>' : ' '}${m.displayName}`}</Text>,
        }}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    await flushEffects();

    const expandedHint =
      (uiExpanded.lastFrame() ?? '').split('\n').find((line) => line.includes(k0)) ?? '';
    const e0 = expandedHint.indexOf(k0);
    const e1 = expandedHint.indexOf(k1);
    const e2 = expandedHint.indexOf(k2);
    const e3 = expandedHint.indexOf(k3);
    expect(e0).toBeGreaterThanOrEqual(0);
    expect(e1).toBeGreaterThan(e0);
    expect(e2).toBeGreaterThan(e1);
    expect(e3).toBeGreaterThan(e2);
    uiExpanded.unmount();

    const uiTerminal = mount(
      <TwoColumnPicker<Tool, Route>
        title="Planner"
        initialColumn="left"
        leftProps={{
          items: TOOLS,
          getKey: (t) => t.id,
          terminalPane: () => ({
            label: 'Inherit',
            verb: 'select',
            lines: ['Terminal info'],
          }),
          renderRow: (t) => <Text>{t.displayName}</Text>,
        }}
        rightProps={{
          items: ROWS,
          getKey: (m) => m.id,
          renderRow: (m) => <Text>{m.displayName}</Text>,
        }}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    await flushEffects();

    const terminalHint =
      (uiTerminal.lastFrame() ?? '').split('\n').find((line) => line.includes(k1)) ?? '';
    expect(terminalHint.indexOf(k0)).toBe(-1);
    const t1 = terminalHint.indexOf(k1);
    const t2 = terminalHint.indexOf(k2);
    const t3 = terminalHint.indexOf(k3);
    expect(t1).toBeGreaterThanOrEqual(0);
    expect(t2).toBeGreaterThan(t1);
    expect(t3).toBeGreaterThan(t2);
    uiTerminal.unmount();
  });
});

describe('TwoColumnPicker rows that cycle in place', () => {
  interface Ladder extends Model {
    /** 'stepped' owns the click too, 'held' only claims the space key. */
    cycle: CycleOutcome;
  }
  // The query filters on `id`, so a space that reaches it empties the column —
  // which is how each test tells a swallowed space from a typed one.
  const LADDER: Ladder[] = [
    { id: 'luna', displayName: 'GPT-5.6 Luna', cycle: 'none' },
    { id: 'effort', displayName: 'effort High', cycle: 'stepped' },
    { id: 'family', displayName: 'Family Parent', cycle: 'held' },
  ];

  beforeEach(() => {
    forceUnicodeGlyphs();
    resetAllStores();
    _resetMouseZones();
    terminalSizeStore.__testReset({ cols: 120, rows: 40, isSmall: false });
  });

  function renderLadder(opts: {
    initialIndex: number;
    cycled: string[];
    collapses: string[];
    confirms?: string[];
  }) {
    return mount(
      <TwoColumnPicker<Tool, Ladder>
        title="Planner"
        initialColumn="right"
        leftProps={{
          items: TOOLS,
          getKey: (t) => t.id,
          renderRow: (t, { isCursor }) => <Text>{`${isCursor ? '>' : ' '}${t.displayName}`}</Text>,
        }}
        rightProps={{
          items: LADDER,
          getKey: (m) => m.id,
          initialIndex: opts.initialIndex,
          renderRow: (m, { isCursor }) => <Text>{`${isCursor ? '>' : ' '}${m.displayName}`}</Text>,
          isExpanded: true,
          onCollapse: () => opts.collapses.push('collapse'),
          onCycle: (m) => {
            if (m.cycle === 'stepped') opts.cycled.push(m.id);
            return m.cycle;
          },
        }}
        onConfirm={(_l, r) => opts.confirms?.push(r?.id ?? 'none')}
        onCancel={() => {}}
      />,
    );
  }

  it('spends space on the row that cycles, leaving the query untouched', async () => {
    const cycled: string[] = [];
    const collapses: string[] = [];
    const ui = renderLadder({ initialIndex: 1, cycled, collapses });
    await flushEffects();

    ui.stdin.write(' ');
    await flushEffects();

    expect(cycled).toEqual(['effort']);
    expect(collapses).toEqual([]);
    expect(ui.lastFrame()).toContain('effort High');
    expect(ui.lastFrame()).toContain('GPT-5.6 Luna');
  });

  it('lets space through to the query on a row that does not cycle', async () => {
    const cycled: string[] = [];
    const collapses: string[] = [];
    const ui = renderLadder({ initialIndex: 0, cycled, collapses });
    await flushEffects();

    ui.stdin.write(' ');
    await flushEffects();

    expect(cycled).toEqual([]);
    expect(collapses).toEqual(['collapse']);
    expect(ui.lastFrame()).not.toContain('GPT-5.6 Luna');
  });

  it('keeps the left arrow as the way out of a cycling row', async () => {
    const cycled: string[] = [];
    const collapses: string[] = [];
    const ui = renderLadder({ initialIndex: 1, cycled, collapses });
    await flushEffects();

    ui.stdin.write(LEFT);
    await flushEffects();

    expect(ui.lastFrame()).toContain('>Alpha');
    expect(ui.lastFrame()).toContain('effort High');
    expect(cycled).toEqual([]);
  });

  it('leaves space to the tool query while the Models column is unfocused', async () => {
    const cycled: string[] = [];
    const collapses: string[] = [];
    const ui = renderLadder({ initialIndex: 1, cycled, collapses });
    await flushEffects();

    ui.stdin.write(LEFT);
    await flushEffects();
    ui.stdin.write(' ');
    await flushEffects();

    expect(cycled).toEqual([]);
    expect(collapses).toEqual(['collapse']);
    expect(ui.lastFrame()).toContain('No items match');
  });

  it('takes focus back to the Models column when a click steps a row there', async () => {
    const cycled: string[] = [];
    const collapses: string[] = [];
    const ui = renderLadder({ initialIndex: 1, cycled, collapses });
    await flushEffects();

    ui.stdin.write(LEFT);
    await flushEffects();
    expect(ui.lastFrame()).toContain('>Alpha');

    collectClickableZones({ cols: 120, rows: 40 }).get('runner-right:effort')?.();
    await flushEffects();

    expect(cycled).toEqual(['effort']);
    expect(ui.lastFrame()).toContain('>effort High');
    expect(ui.lastFrame()).not.toContain('>Alpha');
  });

  it('confirms the row that space cycles when Enter is pressed on it', async () => {
    const cycled: string[] = [];
    const collapses: string[] = [];
    const confirms: string[] = [];
    const ui = renderLadder({ initialIndex: 1, cycled, collapses, confirms });
    await flushEffects();

    ui.stdin.write('\r');
    await flushEffects();

    expect(confirms).toEqual(['effort']);
    expect(cycled).toEqual([]);
  });

  it('swallows space on a row that holds the key, leaving the expansion open', async () => {
    const cycled: string[] = [];
    const collapses: string[] = [];
    const ui = renderLadder({ initialIndex: 2, cycled, collapses });
    await flushEffects();

    ui.stdin.write(' ');
    await flushEffects();

    expect(collapses).toEqual([]);
    expect(cycled).toEqual([]);
    expect(ui.lastFrame()).toContain('GPT-5.6 Luna');
  });

  it('keeps a row that only holds the key clickable', async () => {
    const cycled: string[] = [];
    const collapses: string[] = [];
    const confirms: string[] = [];
    renderLadder({ initialIndex: 0, cycled, collapses, confirms });
    await flushEffects();

    collectClickableZones({ cols: 120, rows: 40 }).get('runner-right:family')?.();
    await flushEffects();

    expect(confirms).toEqual(['family']);
  });
});
