import { beforeEach, describe, expect, it } from 'vitest';
import { useState } from 'react';
import { Text } from 'ink';
import { forceUnicodeGlyphs } from '#testing/helpers/glyphs.js';
import { flushEffects, renderFeature, tick } from '#testing/helpers/ink.js';
import { resetAllStores } from '#testing/helpers/stores.js';
import { _resetMouseZones } from '../../../lib/terminal/mouse-zones.js';
import { filterByFields } from '../../../components/pickers/filtering.js';
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

/** The one name holding a space, so a query that keeps one narrows to it and nothing else. */
const SPACED_TOOL: Tool = { id: 'alpha-two', displayName: 'Alpha Two' };

const ALPHA_MODELS: Model[] = [
  { id: 'a-1', displayName: 'alpha-1' },
  { id: 'a-2', displayName: 'alpha-2' },
];

const BACKSPACE = '\u007f';
const ESC = '\u001B';
const DOWN = '\u001B[B';

const LAUNCHER: Tool = { id: 'add-custom', displayName: '+ Add custom command…' };

function launcherPicker(opts: {
  initialIndex: number;
  onConfirm?: (left: Tool, right: Model | null) => void;
}) {
  return (
    <TwoColumnPicker<Tool, Model>
      title="Picker"
      leftProps={{
        items: [...TOOLS, LAUNCHER],
        getKey: (t) => t.id,
        isDisabled: (t) => !!t.disabled,
        terminalPane: (t) =>
          t.id === LAUNCHER.id
            ? { label: 'Custom command', verb: 'add custom', lines: ['run a custom command'] }
            : undefined,
        filterBy: (t, query) =>
          t.id === LAUNCHER.id || filterByFields(t, query, ['id', 'displayName']),
        initialIndex: opts.initialIndex,
        renderRow: (t, { isCursor }) => <Text>{`${isCursor ? '>' : ' '}${t.displayName}`}</Text>,
      }}
      rightProps={{
        items: [],
        getKey: (m) => m.id,
        renderRow: (m) => <Text>{m.displayName}</Text>,
      }}
      onConfirm={opts.onConfirm ?? (() => {})}
      onCancel={() => {}}
    />
  );
}

function customRowPicker(opts: {
  onConfirm?: (left: Tool, right: Model | null) => void;
  onCancel?: () => void;
  onCustomSelect?: (left: Tool) => void;
}) {
  return (
    <TwoColumnPicker<Tool, Model>
      title="Picker"
      leftProps={{
        items: TOOLS,
        getKey: (t) => t.id,
        isDisabled: (t) => !!t.disabled,
        renderRow: (t) => <Text>{t.displayName}</Text>,
      }}
      rightProps={{
        items: ALPHA_MODELS,
        getKey: (m) => m.id,
        renderRow: (m) => <Text>{m.displayName}</Text>,
        customRow: { onSelect: opts.onCustomSelect ?? (() => {}) },
      }}
      onConfirm={opts.onConfirm ?? (() => {})}
      onCancel={opts.onCancel ?? (() => {})}
    />
  );
}

describe('TwoColumnPicker type-anywhere filtering', () => {
  beforeEach(() => {
    forceUnicodeGlyphs();
    resetAllStores();
    _resetMouseZones();
  });

  it('narrows continuously as each character is typed, then confirms with zero arrow presses', async () => {
    const confirms: Array<{ l: string; r: string | null }> = [];
    function Consumer() {
      const [leftId, setLeftId] = useState('alpha');
      return (
        <TwoColumnPicker<Tool, Model>
          title="Picker"
          leftProps={{
            items: TOOLS,
            getKey: (t) => t.id,
            isDisabled: (t) => !!t.disabled,
            renderRow: (t, { isCursor }) => (
              <Text>{`${isCursor ? '>' : ' '}${t.displayName}`}</Text>
            ),
          }}
          rightProps={{
            items: leftId === 'alpha' ? ALPHA_MODELS : [],
            getKey: (m) => m.id,
            renderRow: (m) => <Text>{m.displayName}</Text>,
            onLeftChange: (t) => {
              setLeftId(t.id);
            },
          }}
          onConfirm={(l, r) => {
            confirms.push({ l: l.id, r: r?.id ?? null });
          }}
          onCancel={() => {}}
        />
      );
    }
    const ui = renderFeature(<Consumer />);
    await flushEffects();

    ui.stdin.write('a'); // matches Alpha, Beta, Gamma
    await flushEffects();
    expect(ui.lastFrame()).toContain('Beta');

    await flushEffects();
    ui.stdin.write('l'); // 'al' narrows to Alpha with no arrow press in between
    await flushEffects();
    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('>Alpha');
    expect(frame).not.toContain('Beta');
    expect(frame).not.toContain('Gamma');

    await flushEffects();
    ui.stdin.write('\r');
    await flushEffects();
    ui.stdin.write('\r');
    await tick(20);
    expect(confirms).toEqual([{ l: 'alpha', r: 'a-1' }]);
    ui.unmount();
  });

  it('typing while the cursor sits on the launcher row filters the list above it', async () => {
    const ui = renderFeature(launcherPicker({ initialIndex: 3 }));
    await flushEffects();
    expect(ui.lastFrame()).toContain('>+ Add custom command…');

    await flushEffects();
    ui.stdin.write('a');
    await flushEffects();
    ui.stdin.write('l');
    await flushEffects();

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('>Alpha');
    expect(frame).not.toContain('Gamma');
    expect(frame).toContain('+ Add custom command…');
    ui.unmount();
  });

  it('keeps the launcher visible and confirmable under a non-matching query', async () => {
    const confirms: Array<{ l: string; r: string | null }> = [];
    const ui = renderFeature(
      launcherPicker({
        initialIndex: 0,
        onConfirm: (l, r) => {
          confirms.push({ l: l.id, r: r?.id ?? null });
        },
      }),
    );
    await flushEffects();

    ui.stdin.write('z');
    await flushEffects();
    ui.stdin.write('z');
    await flushEffects();

    const frame = ui.lastFrame() ?? '';
    expect(frame).not.toContain('Alpha');
    expect(frame).toContain('>+ Add custom command…');

    await flushEffects();
    ui.stdin.write('\r');
    await tick(20);
    expect(confirms).toEqual([{ l: 'add-custom', r: null }]);
    ui.unmount();
  });

  it('backspace widens the match set', async () => {
    const ui = renderFeature(customRowPicker({}));
    await flushEffects();

    ui.stdin.write('a');
    await flushEffects();
    ui.stdin.write('l');
    await flushEffects();
    expect(ui.lastFrame()).not.toContain('Beta');

    await flushEffects();
    ui.stdin.write(BACKSPACE);
    await flushEffects();
    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('Beta');
    expect(frame).toContain('Gamma');
    ui.unmount();
  });

  it('Escape clears a non-empty left filter; the next Escape cancels', async () => {
    let cancelled = 0;
    const ui = renderFeature(
      customRowPicker({
        onCancel: () => {
          cancelled++;
        },
      }),
    );
    await flushEffects();

    ui.stdin.write('a');
    await flushEffects();
    ui.stdin.write('l');
    await flushEffects();
    expect(ui.lastFrame()).not.toContain('Beta');

    await flushEffects();
    ui.stdin.write(ESC);
    await flushEffects();
    expect(cancelled).toBe(0);
    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('Beta');
    expect(frame).toContain('Gamma');

    await flushEffects();
    ui.stdin.write(ESC);
    await tick(20);
    expect(cancelled).toBe(1);
    ui.unmount();
  });

  it('typing in the right column lands on the first match past the custom row and Enter confirms it', async () => {
    const confirms: Array<string | null> = [];
    const ui = renderFeature(
      customRowPicker({
        onConfirm: (_l, r) => {
          confirms.push(r?.id ?? null);
        },
      }),
    );
    await flushEffects();

    ui.stdin.write('\r'); // focus right on the first model past the custom row
    await flushEffects();
    ui.stdin.write('2'); // only a-2 matches
    await flushEffects();

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('+ Add custom model…');
    expect(frame).not.toContain('alpha-1');

    await flushEffects();
    ui.stdin.write('\r');
    await tick(20);
    expect(confirms).toEqual(['a-2']);
    ui.unmount();
  });

  it('a right query with no matches falls back onto the custom row; Escape clears it before cancelling', async () => {
    let cancelled = 0;
    const opened: string[] = [];
    const ui = renderFeature(
      customRowPicker({
        onCancel: () => {
          cancelled++;
        },
        onCustomSelect: (l) => {
          opened.push(l.id);
        },
      }),
    );
    await flushEffects();

    ui.stdin.write('\r');
    await flushEffects();
    ui.stdin.write('z');
    await flushEffects();
    expect(ui.lastFrame()).not.toContain('alpha-1');

    await flushEffects();
    ui.stdin.write('\r'); // Enter on the custom row opens the custom-model flow
    await flushEffects();
    expect(opened).toEqual(['alpha']);

    await flushEffects();
    ui.stdin.write(ESC); // clears the query instead of cancelling
    await flushEffects();
    expect(cancelled).toBe(0);
    expect(ui.lastFrame()).toContain('alpha-1');

    await flushEffects();
    ui.stdin.write(ESC);
    await tick(20);
    expect(cancelled).toBe(1);
    ui.unmount();
  });

  it('down-arrow reaches the last model past the custom row', async () => {
    const confirms: Array<string | null> = [];
    const ui = renderFeature(
      customRowPicker({
        onConfirm: (_l, r) => {
          confirms.push(r?.id ?? null);
        },
      }),
    );
    await flushEffects();

    ui.stdin.write('\r'); // focus right on a-1
    await flushEffects();
    ui.stdin.write(DOWN); // a-2, past the end of the filterable items
    await flushEffects();
    ui.stdin.write('\r');
    await tick(20);

    expect(confirms).toEqual(['a-2']);
    ui.unmount();
  });
});

const EFFORT_LEVELS = ['low', 'medium', 'high'] as const;

/**
 * The real picker with a value row in the right column: `onCycle` reports `stepped` for it and
 * `none` for an ordinary model, which is the contract `cycleRightRow` meets in the runner picker.
 */
function effortPicker(opts: { onCycle?: (id: string) => void }) {
  function Consumer() {
    const [level, setLevel] = useState(0);
    return (
      <TwoColumnPicker<Tool, Model>
        title="Picker"
        leftProps={{
          items: TOOLS,
          getKey: (t) => t.id,
          isDisabled: (t) => !!t.disabled,
          renderRow: (t) => <Text>{t.displayName}</Text>,
        }}
        rightProps={{
          items: [
            { id: 'a-1', displayName: 'alpha-1' },
            { id: 'effort', displayName: 'effort' },
          ],
          getKey: (m) => m.id,
          renderRow: (m) => (
            <Text>{m.id === 'effort' ? `effort ${EFFORT_LEVELS[level]}` : m.displayName}</Text>
          ),
          onCycle: (m) => {
            if (m.id !== 'effort') return 'none';
            opts.onCycle?.(m.id);
            setLevel((prev) => (prev + 1) % EFFORT_LEVELS.length);
            return 'stepped';
          },
        }}
        onConfirm={() => {}}
        onCancel={() => {}}
      />
    );
  }
  return <Consumer />;
}

// REQ-011: one key, three meanings, each pinned against the picker the user actually drives.
describe('TwoColumnPicker space policy', () => {
  beforeEach(() => {
    forceUnicodeGlyphs();
    resetAllStores();
    _resetMouseZones();
  });

  it('leaves an ordinary row alone when space is the first thing typed', async () => {
    const ui = renderFeature(launcherPicker({ initialIndex: 0 }));
    await flushEffects();
    expect(ui.lastFrame()).toContain('>Alpha');

    await flushEffects();
    ui.stdin.write(' ');
    await flushEffects();

    const frame = ui.lastFrame() ?? '';
    // No query was started: both columns still invite one and nothing was filtered out.
    expect(frame.split('Type to filter…').length - 1).toBe(2);
    expect(frame).toContain('Beta');
    expect(frame).toContain('Gamma');
    // The cursor did not move, and no row was selected on the way past.
    expect(frame).toContain('>Alpha');
    ui.unmount();
  });

  it('keeps a space inside a query that already has text', async () => {
    const ui = renderFeature(
      <TwoColumnPicker<Tool, Model>
        title="Picker"
        leftProps={{
          items: [...TOOLS, SPACED_TOOL],
          getKey: (t) => t.id,
          isDisabled: (t) => !!t.disabled,
          filterBy: (t, query) => filterByFields(t, query, ['id', 'displayName']),
          renderRow: (t, { isCursor }) => <Text>{`${isCursor ? '>' : ' '}${t.displayName}`}</Text>,
        }}
        rightProps={{
          items: [],
          getKey: (m) => m.id,
          renderRow: (m) => <Text>{m.displayName}</Text>,
        }}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    await flushEffects();

    ui.stdin.write('a');
    await flushEffects();
    expect(ui.lastFrame()).toContain('Gamma');

    await flushEffects();
    ui.stdin.write(' ');
    await flushEffects();

    const frame = ui.lastFrame() ?? '';
    // 'a ' is a narrower query than 'a', not the same one: only the spaced name survives it.
    expect(frame).toContain('>Alpha Two');
    expect(frame).not.toContain('Beta');
    expect(frame).not.toContain('Gamma');
    ui.unmount();
  });

  it('steps the value row when space lands on it, and starts no query in that column', async () => {
    const cycled: string[] = [];
    const ui = renderFeature(effortPicker({ onCycle: (id) => cycled.push(id) }));
    await flushEffects();

    ui.stdin.write('\r'); // focus the right column on alpha-1
    await flushEffects();
    ui.stdin.write(DOWN); // onto the value row
    await flushEffects();
    expect(ui.lastFrame()).toContain('effort low');

    await flushEffects();
    ui.stdin.write(' ');
    await flushEffects();
    expect(ui.lastFrame()).toContain('effort medium');

    await flushEffects();
    ui.stdin.write(' ');
    await flushEffects();

    const frame = ui.lastFrame() ?? '';
    expect(frame).toContain('effort high');
    expect(cycled).toEqual(['effort', 'effort']);
    // The row took the key, so the right column never saw it as a query character.
    expect(frame).toContain('alpha-1');
    ui.unmount();
  });
});
