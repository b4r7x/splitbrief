import { beforeEach, describe, expect, it } from 'vitest';
import { useState } from 'react';
import { Text } from 'ink';
import { forceUnicodeGlyphs } from '#testing/helpers/glyphs.js';
import { flushEffects, renderFeature, tick } from '#testing/helpers/ink.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { _resetMouseZones } from '../../../lib/terminal/mouse-zones.js';
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
    return renderFeature(
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
    const ui = renderFeature(
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
    await tick(20);
    ui.stdin.write('\r');
    await tick(20);
    expect(expanded).toEqual(['luna']);
    expect(confirms).toEqual([]);
    // The cursor moved onto the first row the expansion revealed.
    expect(ui.lastFrame()).toContain('>openrouter route');
    ui.unmount();
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
    await tick(20);
    ui.stdin.write('\r');
    await tick(20);
    expect(confirms).toEqual(['solo']);
    expect(expanded).toEqual([]);
    ui.unmount();
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
    ui.unmount();
  });
});
